require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const multer = require('multer');
const csv = require('csv-parser');
const PDFDocument = require('pdfkit');
const { createClient } = require('@supabase/supabase-js');

// 1. INICIALIZAÇÃO DA APLICAÇÃO (Tem que vir antes das rotas!)
const app = express();
const PORT = process.env.PORT || 3000;

// 2. VARIÁVEIS DE ESTADO E CRIPTOGRAFIA
let hashAnterior = "0000000000000000000000000000000000000000000000000000000000000000";
let eleicaoAtiva = false;
let tempoEncerramento = null;

// Função Criptográfica
function registrarVotoCriptografado(chapaId, turma) {
    const timestamp = new Date().toISOString();
    const dadosVoto = `${timestamp}|${chapaId}|${turma}|${hashAnterior}`;
    const hashAtual = crypto.createHash('sha256').update(dadosVoto).digest('hex');
    const linhaLog = `[${timestamp}] HASH:${hashAtual} | CHAPA:${chapaId}\n`;
    
    try {
        fs.appendFileSync('backup_urna_1.log', linhaLog, 'utf8');
        fs.appendFileSync('backup_urna_2.log', linhaLog, 'utf8');
        fs.appendFileSync('backup_urna_3.log', linhaLog, 'utf8');
    } catch (errLog) {
        console.error("Erro ao gravar nos arquivos de backup:", errLog);
    }
    hashAnterior = hashAtual; 
}

// Middleware de Estado da Eleição
const verificarEstadoEleicao = (req, res, next) => {
    if (!eleicaoAtiva) {
        return res.status(403).json({ erro: "A eleição está encerrada ou suspensa pelo Admin." });
    }
    next();
};

// 3. MIDDLEWARES DE SEGURANÇA E CONEXÃO BÁSICA
app.use(helmet());
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
app.use(cors(allowedOrigins.length ? { origin: allowedOrigins } : undefined));
app.use(express.json());

function exigirTokenAdmin(req, res, next) {
    const token = req.get('x-admin-token');
    if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ erro: "Acesso administrativo não autorizado." });
    }
    next();
}

const limiterGeral = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100,
    message: { erro: "Muitas requisições deste IP. Tente novamente mais tarde." }
});
app.use('/api/', limiterGeral);

const limiterVoto = rateLimit({
    windowMs: 1 * 60 * 1000, 
    max: 5, 
    message: { erro: "Taxa de votação muito alta. Aguarde um momento." }
});
app.use('/api/votar', limiterVoto);

// Supabase Setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ==========================================
// ROTAS GERAIS E DE ADMINISTRAÇÃO
// ==========================================

app.get('/', (req, res) => res.json({ status: "Online", mensagem: "Servidor do IFVote RJ rodando!" }));

app.get('/teste-banco', (req, res) => {
    if (supabaseUrl && supabaseKey) {
        res.json({ status: "Sucesso", mensagem: "Supabase configurado!" });
    } else {
        res.status(500).json({ status: "Erro", mensagem: "Chaves não encontradas no .env" });
    }
});

app.post('/api/admin/iniciar', exigirTokenAdmin, (req, res) => {
    const { minutosAtivos } = req.body; 
    eleicaoAtiva = true;
    if (minutosAtivos) {
        tempoEncerramento = new Date(Date.now() + minutosAtivos * 60000);
        setTimeout(() => { eleicaoAtiva = false; }, minutosAtivos * 60000);
    }
    res.json({ status: "Ativa", encerramento_previsto: tempoEncerramento });
});

app.post('/api/eleitores', exigirTokenAdmin, async (req, res) => {
    const { matricula, nome, turma } = req.body;
    if (!matricula || !nome || !turma) return res.status(400).json({ erro: "Dados incompletos." });

    const { error } = await supabase.from('eleitores_aptos').insert([{ matricula, nome, turma }]);
    if (error) {
        if (error.code === '23505') return res.status(400).json({ erro: "Matrícula já cadastrada!" });
        return res.status(500).json({ erro: "Erro no banco.", detalhe: error.message });
    }
    res.status(201).json({ mensagem: "Eleitor cadastrado com sucesso!" });
});

// ==========================================
// ROTA PRINCIPAL: VOTAÇÃO (COM ORDEM CORRIGIDA)
// ==========================================
app.post('/api/votar', verificarEstadoEleicao, async (req, res) => {
    const { matricula, chapaId } = req.body;
    if (!matricula || !chapaId) return res.status(400).json({ erro: "Matrícula e Chapa são obrigatórios." });

    // 1. Busca eleitor
    const { data: eleitor, error: erroBusca } = await supabase.from('eleitores_aptos').select('*').eq('matricula', matricula).single();
    if (erroBusca || !eleitor) return res.status(404).json({ erro: "Eleitor não encontrado ou inativo." });

    // 2. Trava de voto duplo
    if (eleitor.votou === true) return res.status(403).json({ erro: "Fraude detectada: Eleitor já votou." });

    // 3. Salva no banco anonimamente
    const { error: erroVoto } = await supabase.from('votos_registrados').insert([{ chapa_id: chapaId, turma_eleitor: eleitor.turma }]);
    if (erroVoto) return res.status(500).json({ erro: "Erro ao depositar o voto." });

    // 4. Auditoria Criptografada (Apenas DEPOIS do voto ser aprovado)
    registrarVotoCriptografado(chapaId, eleitor.turma);

    // 5. Marca presença
    await supabase.from('eleitores_aptos').update({ votou: true }).eq('matricula', matricula);
    res.status(200).json({ mensagem: "Voto computado com sucesso e sigilo garantido!" });
});

// ==========================================
// RESULTADOS, PDF E UPLOAD CSV
// ==========================================
app.get('/api/resultados', async (req, res) => {
    const { data: votos, error } = await supabase.from('votos_registrados').select('chapa_id');
    if (error) return res.status(500).json({ erro: "Erro na apuração." });
    
    const placar = votos.reduce((acc, voto) => {
        acc[voto.chapa_id] = (acc[voto.chapa_id] || 0) + 1;
        return acc;
    }, {});
    res.status(200).json({ total_votos: votos.length, apuracao: placar });
});

app.get('/api/admin/zeresima', exigirTokenAdmin, async (req, res) => {
    const { count } = await supabase.from('votos_registrados').select('*', { count: 'exact', head: true });
    if (count > 0) return res.status(400).json({ erro: "Urna não está zerada!" });

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=zeresima.pdf');
    doc.pipe(res);
    doc.fontSize(20).text('IFVOTE - ZERÉSIMA OFICIAL', { align: 'center' }).moveDown();
    doc.fontSize(12).text(`Data/Hora: ${new Date().toLocaleString('pt-BR')}`);
    doc.text(`Status: URNA CONFERIDA E ZERADA\nTotal de votos: 0`).moveDown(5);
    doc.text('________________________________________________', { align: 'center' });
    doc.text('Presidente da Comissão Eleitoral', { align: 'center' });
    doc.end();
});

app.get('/api/admin/boletim', exigirTokenAdmin, async (req, res) => {
    const { data: votos, error } = await supabase.from('votos_registrados').select('chapa_id');
    if (error) return res.status(500).json({ erro: "Erro ao buscar Boletim." });

    const placar = votos.reduce((acc, voto) => {
        acc[voto.chapa_id] = (acc[voto.chapa_id] || 0) + 1;
        return acc;
    }, {});

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=boletim_urna.pdf');
    doc.pipe(res);
    doc.fontSize(20).text('IFVOTE - BOLETIM DE URNA', { align: 'center' }).moveDown();
    doc.fontSize(12).text(`Data/Hora: ${new Date().toLocaleString('pt-BR')}`);
    doc.text(`Total de Eleitores: ${votos.length}`).moveDown();
    doc.text('--- RESULTADO DA APURAÇÃO ---');
    for (const [chapa, qtd] of Object.entries(placar)) doc.text(`CHAPA ${chapa}: ${qtd} votos`);
    doc.moveDown(4).fontSize(9).text(`Hash de Integridade (Último Bloco): ${hashAnterior}`, { color: 'gray' });
    doc.moveDown(4).fontSize(12).fillColor('black').text('________________________________________________', { align: 'center' });
    doc.text('Presidente da Comissão Eleitoral', { align: 'center' });
    doc.end();
});

const upload = multer({ dest: 'uploads/' });
app.post('/api/admin/importar-csv', exigirTokenAdmin, upload.single('arquivo'), (req, res) => {
    if (!req.file) return res.status(400).json({ erro: "Nenhum arquivo CSV enviado." });
    const resultados = [];
    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (data) => resultados.push(data))
        .on('end', async () => {
            try {
                const { error } = await supabase.from('eleitores_aptos').insert(resultados);
                fs.unlinkSync(req.file.path); 
                if (error) {
                    if (error.code === '23505') return res.status(400).json({ erro: "Matrículas duplicadas!" });
                    return res.status(500).json({ erro: "Erro no banco.", detalhe: error.message });
                }
                res.status(200).json({ mensagem: `${resultados.length} eleitores importados via CSV!` });
            } catch (err) {
                res.status(500).json({ erro: "Erro no processamento do arquivo." });
            }
        });
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Teste o Supabase em: http://localhost:${PORT}/teste-banco`);
});
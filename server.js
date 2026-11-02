
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js'); // Importa o Supabase

const app = express();
const PORT = process.env.PORT || 3000;
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// 1. Aplica cabeçalhos de segurança cibernética
app.use(helmet());

// 2. Proteção contra Ataques de Força Bruta / Negação de Serviço (DoS)
// Limita a 100 requisições por IP a cada 15 minutos na API geral
const limiterGeral = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100,
    message: { erro: "Muitas requisições deste IP. Tente novamente mais tarde." }
});
app.use('/api/', limiterGeral);

// Limite estrito para a rota de VOTAÇÃO (evita robôs disparando votos)
const limiterVoto = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minuto
    max: 5, // No máximo 5 tentativas por minuto por IP de urna
    message: { erro: "Taxa de votação muito alta. Aguarde um momento." }
});
app.use('/api/votar', limiterVoto);

// Pegando as chaves do arquivo .env
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

// Criando a conexão com o banco de dados
const supabase = createClient(supabaseUrl, supabaseKey);

// Configurações de segurança e formato de dados
app.use(cors());
app.use(express.json());

// Rota padrão
app.get('/', (req, res) => {
    res.json({ status: "Online", mensagem: "Servidor do IFVote RJ rodando!" });
});

// Nova Rota para testar a configuração do Supabase
app.get('/teste-banco', async (req, res) => {
    if (supabaseUrl && supabaseKey) {
        res.json({
            status: "Sucesso",
            mensagem: "Supabase configurado! O cliente está pronto para ler e gravar dados."
        });
    } else {
        res.status(500).json({
            status: "Erro",
            mensagem: "Chaves do Supabase não encontradas. Verifique o arquivo .env"
        });
    }
});

// Rota para a Comissão Eleitoral cadastrar eleitores aptos
app.post('/api/eleitores', async (req, res) => {
    const { matricula, nome, turma } = req.body;

    // 1. Verifica se a requisição mandou todos os dados necessários
    if (!matricula || !nome || !turma) {
        return res.status(400).json({ erro: "É obrigatório enviar matrícula, nome e turma." });
    }

    // 2. Tenta inserir os dados no Supabase
    const { data, error } = await supabase
        .from('eleitores_aptos')
        .insert([{ matricula: matricula, nome: nome, turma: turma }]);

    // 3. Trata possíveis erros
    if (error) {
        // Erro 23505 no PostgreSQL significa "Chave duplicada" (matrícula já existe)
        if (error.code === '23505') {
            return res.status(400).json({ erro: "Esta matrícula já está cadastrada no sistema!" });
        }
        return res.status(500).json({ erro: "Erro ao salvar no banco.", detalhe: error.message });
    }

    // 4. Sucesso!
    res.status(201).json({ mensagem: "Eleitor cadastrado com sucesso!" });
});
// Rota principal: Processar o Voto
app.post('/api/votar', async (req, res) => {
    const fs = require('fs');

// [AUDITORIA LOCAL REDUNDANTE]
// Grava um log local append-only (sem expor quem votou em quem)
const logAuditoria = `[${new Date().toISOString()}] Voto registrado com sucesso na chapa: ${chapaId}\n`;
fs.appendFileSync('auditoria_votos.log', logAuditoria, 'utf8');
    const { matricula, chapaId } = req.body;

    if (!matricula || !chapaId) {
        return res.status(400).json({ erro: "Matrícula e Chapa são obrigatórios." });
    }

    // PASSO 1: Buscar o eleitor no banco
    const { data: eleitor, error: erroBusca } = await supabase
        .from('eleitores_aptos')
        .select('*')
        .eq('matricula', matricula)
        .single(); // .single() garante que pegamos apenas 1 pessoa

    if (erroBusca || !eleitor) {
        return res.status(404).json({ erro: "Eleitor não encontrado ou não apto a votar." });
    }

    // PASSO 2: Verificar se já votou
    if (eleitor.votou === true) {
        return res.status(403).json({ erro: "Fraude detectada: Este eleitor já registrou um voto." });
    }

    // PASSO 3: Registrar o voto de forma ANÔNIMA
    // Note que NÃO estamos enviando a matrícula para a tabela de votos
    const { error: erroVoto } = await supabase
        .from('votos_registrados')
        .insert([
            { 
                chapa_id: chapaId, 
                turma_eleitor: eleitor.turma // Guardamos a turma só para estatísticas, se quiser
            }
        ]);

    if (erroVoto) {
        return res.status(500).json({ erro: "Erro no servidor ao depositar o voto." });
    }

    // PASSO 4: Marcar o eleitor como "já votou" na lista de presença
    const { error: erroAtualizacao } = await supabase
        .from('eleitores_aptos')
        .update({ votou: true })
        .eq('matricula', matricula);

    if (erroAtualizacao) {
        console.error("Erro crítico ao atualizar status do eleitor:", erroAtualizacao);
        // O voto entrou, mas a flag falhou. Num sistema avançado usaríamos "Transactions".
    }

    // Sucesso!
    res.status(200).json({ mensagem: "Voto computado com sucesso e sigilo garantido!" });
});

// Rota para a Comissão Eleitoral acompanhar a apuração
app.get('/api/resultados', async (req, res) => {
    const { data: votos, error } = await supabase
        .from('votos_registrados')
        .select('chapa_id');

    if (error) {
        return res.status(500).json({ erro: "Erro ao buscar a apuração no banco." });
    }

    const placar = votos.reduce((acumulador, voto) => {
        const id = voto.chapa_id;
        acumulador[id] = (acumulador[id] || 0) + 1;
        return acumulador;
    }, {});

    res.status(200).json({
        total_votos: votos.length,
        apuracao: placar
    });
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Teste o Supabase em: http://localhost:${PORT}/teste-banco`);
});

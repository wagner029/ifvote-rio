const { app, BrowserWindow, globalShortcut } = require('electron');
const path = require('path');

let mainWindow;

function criarUrna() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        kiosk: true, // TELA CHEIA TRAVADA (Modo Quiosque)
        autoHideMenuBar: true, // Esconde os menus
        alwaysOnTop: true, // Fica por cima de qualquer outro aviso do Windows
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    // Carrega o seu HTML da urna
    mainWindow.loadFile(path.join(__dirname, 'index.html'));

   
    // TENTATIVA DE FRAUDE: Bloqueia atalhos perigosos
    mainWindow.on('focus', () => {
        globalShortcut.register('CommandOrControl+R', () => { console.log('F5 Bloqueado'); });
        globalShortcut.register('F5', () => { console.log('F5 Bloqueado'); });
        globalShortcut.register('Alt+Tab', () => { console.log('Alt+Tab Bloqueado'); });
        
        // 🚨 ATALHO SECRETO DA EQUIPA TÉCNICA (Ctrl + Shift + X)
        globalShortcut.register('CommandOrControl+Shift+X', () => { 
            console.log('Encerramento forçado pela equipa técnica.');
            app.quit(); // Fecha a urna e liberta o Windows
        });
});

    mainWindow.on('blur', () => {
        globalShortcut.unregisterAll();
    });
}

app.whenReady().then(criarUrna);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
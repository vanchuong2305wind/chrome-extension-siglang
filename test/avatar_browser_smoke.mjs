import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createGunzip } from 'node:zlib';
import { createReadStream } from 'node:fs';

const chrome = process.argv[2];
if (!chrome) throw new Error('Pass the path to Chrome or Edge.');
const assets = resolve('android/app/src/main/assets');
const profile = await mkdtemp(join(tmpdir(), 'signlang-chrome-'));
const types = { html: 'text/html', js: 'text/javascript', json: 'application/json' };
const dictionary = JSON.parse(await readFile(join(assets, 'signs/dictionary.json'), 'utf8'));
const requested = [];
const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname.slice(1);
    const landmark = /^signs\/vsl-[\da-f]{20}\.json$/.test(path);
    if (!landmark && !path.startsWith('avatar/')) {
        response.writeHead(404).end();
        return;
    }
    response.setHeader('Content-Type', types[path.split('.').at(-1)] ?? 'application/octet-stream');
    if (landmark) {
        requested.push(path);
        createReadStream(join(assets, path + '.gzip')).pipe(createGunzip()).pipe(response);
    } else {
        try {
            const data = await readFile(join(assets, path));
            response.end(request.method === 'HEAD' ? undefined : data);
        } catch {
            response.writeHead(404).end();
        }
    }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = spawn(chrome, [
    '--headless', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-background-networking', '--no-first-run', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });

async function until(action, description) {
    for (let i = 0; i < 100; i++) {
        try {
            const value = await action();
            if (value) return value;
        } catch {
            // Browser startup and page navigation may still be in progress.
        }
        await setTimeout(200);
    }
    throw new Error('Timed out: ' + description);
}

try {
    const portFile = await until(() => readFile(join(profile, 'DevToolsActivePort'), 'utf8'), 'Chrome startup');
    const port = portFile.split('\n')[0];
    const tabs = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
    const socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });
    let id = 0;
    function send(method, params = {}) {
        const messageId = ++id;
        return new Promise((resolve, reject) => {
            function receive(event) {
                const response = JSON.parse(event.data);
                if (response.id !== messageId) return;
                socket.removeEventListener('message', receive);
                if (response.error) reject(new Error(response.error.message));
                else resolve(response.result);
            }
            socket.addEventListener('message', receive);
            socket.send(JSON.stringify({ id: messageId, method, params }));
        });
    }
    async function evaluate(expression) {
        const response = await send('Runtime.evaluate', { expression, returnByValue: true });
        return response.result.value;
    }
    await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', {
        source: "window.statuses = []; window.SignLang = {status: s => statuses.push(s), viewReady: () => {}};",
    });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/avatar/index.html' });
    await until(() => evaluate("window.statuses?.includes('Avatar VRM toàn thân sẵn sàng')"), 'original VRM load');
    assert.equal(requested.length, 0);
    const signs = ['cảm ơn', 'bệnh viện'].map(vi => ({ vi, gloss: dictionary.entries[vi], found: true }));
    await evaluate('window.playSigns(' + JSON.stringify(signs) + ')');
    await until(() => evaluate("window.statuses?.includes('Đang ký: bệnh viện')"), 'playing real landmarks');
    const statuses = await evaluate('window.statuses');
    assert.deepEqual(statuses.filter(status => status.startsWith('Đang ký:')), ['Đang ký: cảm ơn', 'Đang ký: bệnh viện']);
    assert.equal(requested.length, 2);
    socket.close();
    console.log('Original VRM loaded and played cảm ơn → bệnh viện with two on-demand landmark reads.');
} finally {
    server.close();
    const exited = new Promise(resolve => browser.once('exit', resolve));
    browser.kill();
    await Promise.race([exited, setTimeout(2000)]);
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}


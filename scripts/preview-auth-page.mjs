import * as http from 'node:http';
import esbuild from 'esbuild';

const PORT = Number(process.env.PORT ?? 8899);

const STATES = {
  'signed-in': {
    label: 'Signed in',
    options: {
      tone: 'success',
      heading: 'Signed in',
      message: 'Your new API key was handed back to your editor.',
      autoClose: true,
    },
  },
  updated: {
    label: 'Permissions updated',
    options: {
      tone: 'success',
      heading: 'Permissions updated',
      message: 'The permissions of cala_9f21c0 were updated for your editor.',
      autoClose: true,
    },
  },
  'no-key': {
    label: 'No API key received',
    options: {
      tone: 'error',
      heading: 'No API key received',
      message: 'The panel did not hand back a key. Return to your editor and try again.',
    },
  },
};

async function loadCallbackPage() {
  const build = await esbuild.build({
    entryPoints: ['src/authPage.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
  });
  const source = Buffer.from(build.outputFiles[0].text).toString('base64');
  return (await import(`data:text/javascript;base64,${source}`)).callbackPage;
}

function index() {
  const links = Object.entries(STATES)
    .map(([path, { label }]) => `<li><a href="/${path}">${label}</a> <a href="/${path}?closable">(closable)</a></li>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Callback pages</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; line-height: 2">
<h1>Callback pages</h1>
<ul>${links}</ul>
<p>Pages are rebuilt from <code>src/authPage.ts</code> on every request. The <em>closable</em> variant
drops the session history check so the countdown runs in a tab that a real browser would refuse to close.</p>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const requested = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const state = STATES[requested.pathname.slice(1)];

  if (!state) {
    res.writeHead(requested.pathname === '/' ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(index());
    return;
  }

  try {
    const callbackPage = await loadCallbackPage();
    const page = callbackPage(state.options);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(requested.searchParams.has('closable') ? page.replace('history.length === 1', 'true') : page);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(error));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`callback page preview on http://127.0.0.1:${PORT}/`);
});

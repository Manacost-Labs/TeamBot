function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function loginRequiredPage(gatewayUrl: string): string {
  const loginUrl = `${gatewayUrl}/signin-with-chatgpt?return_to=%2F`;
  const safeLoginUrl = escapeHtml(loginUrl);
  const scriptLoginUrl = JSON.stringify(loginUrl).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark light">
    <title>Восстановление входа</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #0b0b0c; color: #f5f5f5; }
      main { width: min(420px, calc(100% - 48px)); text-align: center; }
      .loader { width: 32px; height: 32px; margin: 0 auto 24px; border: 3px solid #343438; border-top-color: #f5f5f5; border-radius: 50%; animation: spin .8s linear infinite; }
      h1 { margin: 0 0 10px; font-size: 20px; }
      p { margin: 0 0 22px; color: #aaa; line-height: 1.5; }
      a { display: inline-flex; min-height: 44px; padding: 0 20px; align-items: center; justify-content: center; border-radius: 999px; background: #f5f5f5; color: #111; font-weight: 650; text-decoration: none; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  </head>
  <body>
    <main>
      <div class="loader" aria-hidden="true"></div>
      <h1>Восстанавливаем вход…</h1>
      <p>Сессия ChatGPT истекла. Сейчас откроется безопасный повторный вход.</p>
      <a href="${safeLoginUrl}" target="_top">Войти через ChatGPT</a>
    </main>
    <script>
      const loginUrl = ${scriptLoginUrl};
      try { window.top.location.replace(loginUrl); } catch { window.location.replace(loginUrl); }
    </script>
  </body>
</html>`;
}

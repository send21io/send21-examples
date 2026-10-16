// The send21-pair browser smoke test (one check per flow) run against dewby's build:
//   PLAYWRIGHT_MODULE=... CHROME_PATH=/usr/bin/google-chrome node scripts/smoke-browser.js https://send21io.github.io/send21-examples/dewby/
if (!process.argv[2]) process.argv[2] = "http://127.0.0.1:18790/send21-examples/dewby/";
await import("../../send21-pair/scripts/smoke-browser.js");

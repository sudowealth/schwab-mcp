import http from 'http';

const COBROWSER_URL = 'http://localhost:3456';
const MCP_AUTHORIZE_URL = 'http://localhost:8787/authorize';

const SCHWAB_USER = process.env.SCHWAB_USERNAME;
const SCHWAB_PASS = process.env.SCHWAB_PASSWORD;

if (!SCHWAB_USER || !SCHWAB_PASS) {
  console.error("ERROR: SCHWAB_USERNAME and SCHWAB_PASSWORD environment variables must be set.");
  process.exit(1);
}

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3456,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (data) {
            resolve(JSON.parse(data));
          } else {
            resolve({});
          }
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  console.log(`Navigating to ${MCP_AUTHORIZE_URL}...`);
  await request('POST', '/api/navigate', { url: MCP_AUTHORIZE_URL });
  await delay(3000); // Wait for page to load

  console.log("Fetching DOM to determine current state...");
  let dom = await request('GET', '/api/dom');

  // Cloudflare MCP Approval Screen
  if (dom.includes('Approve') && dom.includes('Deny')) {
    console.log("Detected MCP Approval Screen. Clicking Approve...");
    // The approval button is usually a submit button or has text "Approve"
    // Let's assume there's a button with type submit.
    await request('POST', '/api/click', { selector: 'button[type="submit"]' });
    await delay(3000);
    dom = await request('GET', '/api/dom');
  }

  // Schwab Login Screen
  if (dom.includes('password') || dom.toLowerCase().includes('schwab')) {
    console.log("Detected Schwab Login Screen. Injecting credentials...");
    
    // Most login pages have an input type text/email and type password.
    // Since we are automating via cobrowser, we can just inject into standard selectors.
    await request('POST', '/api/type', { selector: 'input[type="text"], input[name="loginId"]', text: SCHWAB_USER, delay: 50 });
    await delay(500);
    
    await request('POST', '/api/type', { selector: 'input[type="password"]', text: SCHWAB_PASS, delay: 50 });
    await delay(500);

    console.log("Submitting login form...");
    await request('POST', '/api/click', { selector: 'button[type="submit"], input[type="submit"]' });
    
    await delay(5000);
    dom = await request('GET', '/api/dom');
    
    // Handle Consent screen if present
    if (dom.toLowerCase().includes('consent') || dom.toLowerCase().includes('agree') || dom.toLowerCase().includes('allow')) {
        console.log("Consent screen detected. Agreeing...");
        await request('POST', '/api/click', { selector: 'button[type="submit"], button:contains("Agree"), button:contains("Allow")' });
        await delay(5000);
    }

    console.log("OAuth flow automation completed. MCP Server should now be responsive.");
  } else {
    console.log("Could not recognize the current page state. DOM snippet:");
    console.log(dom.substring(0, 500));
  }
}

run().catch(console.error);

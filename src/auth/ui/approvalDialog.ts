import { type ClientInfo } from '@cloudflare/workers-oauth-provider'
import { type ValidatedEnv } from '../../../types/env'
import { APPROVAL_CONFIG } from './config'

/**
 * Configuration for the approval dialog
 */
interface ApprovalDialogOptions {
	/**
	 * Client information for basic display
	 */
	client: ClientInfo | null
	/**
	 * Server information
	 */
	server: {
		name: string
		logo?: string
	}
	/**
	 * State data to encode in the approval flow
	 */
	state: Record<string, any>
	/**
	 * Validated environment configuration
	 */
	config: ValidatedEnv
}

/**
 * Renders an approval page that redirects to Schwab OAuth
 * Following Cloudflare's pattern of minimal custom UI
 *
 * @param request - The HTTP request
 * @param options - Configuration for the approval
 * @returns A Response containing HTML with auto-redirect
 */
export function renderApprovalDialog(
	request: Request,
	options: ApprovalDialogOptions,
): Response {
	const { client, server, state } = options

	// Encode state for the redirect
	const encodedState = btoa(JSON.stringify(state))

	const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Authorizing ${client?.clientName || 'MCP Client'}</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          margin: 0;
          padding: 0;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .container {
          background: white;
          border-radius: 12px;
          padding: 2rem;
          box-shadow: 0 10px 40px rgba(0,0,0,0.1);
          text-align: center;
          max-width: 400px;
          width: 90%;
        }
        .logo {
          width: 64px;
          height: 64px;
          margin: 0 auto 1rem;
          border-radius: 12px;
        }
        h1 {
          margin: 0 0 1rem 0;
          color: #333;
          font-size: 1.5rem;
          font-weight: 600;
        }
        p {
          color: #666;
          margin: 0 0 2rem 0;
          line-height: 1.5;
        }
        .btn {
          background: #0070f3;
          color: white;
          border: none;
          padding: 1rem 2rem;
          border-radius: 8px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          width: 100%;
          transition: background 0.2s;
        }
        .btn:hover {
          background: #0051cc;
        }
        .spinner {
          display: none;
          width: 20px;
          height: 20px;
          border: 2px solid #ffffff40;
          border-top: 2px solid #ffffff;
          border-radius: 50%;
          animation: spin 1s linear infinite;
          margin: 0 auto;
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        .auto-redirect {
          color: #888;
          font-size: 0.9rem;
          margin-top: 1rem;
        }
        .invite-field {
          text-align: left;
          margin-bottom: 1.5rem;
        }
        .invite-field label {
          display: block;
          color: #666;
          font-size: 0.9rem;
          margin-bottom: 0.5rem;
        }
        .invite-field input {
          width: 100%;
          box-sizing: border-box;
          padding: 0.75rem;
          border: 1px solid #ddd;
          border-radius: 8px;
          font-size: 1rem;
        }
      </style>
    </head>
    <body>
      <div class="container">
        ${server.logo ? `<img src="${server.logo}" alt="${server.name}" class="logo">` : ''}
        <h1>Connect to ${server.name}</h1>
        <p><strong>${client?.clientName || 'An MCP Client'}</strong> wants to access your Schwab account through ${server.name}.</p>
        
        <form method="post" action="${new URL(request.url).pathname}" id="approvalForm">
          <input type="hidden" name="state" value="${encodedState}">
          <div class="invite-field">
            <label for="inviteCode">Invite code &mdash; first-time users only</label>
            <input type="text" name="inviteCode" id="inviteCode" placeholder="Leave blank if already enrolled" autocomplete="off">
          </div>
          <button type="submit" class="btn" id="approveBtn">
            <span id="btnText">Continue to Schwab</span>
            <div class="spinner" id="spinner"></div>
          </button>
        </form>
        
        <p class="auto-redirect">Redirecting automatically in <span id="countdown">3</span> seconds...</p>
      </div>

      <script>
        // Auto-submit after countdown
        let countdown = ${APPROVAL_CONFIG.COUNTDOWN_SECONDS};
        const countdownEl = document.getElementById('countdown');
        const form = document.getElementById('approvalForm');
        const btn = document.getElementById('approveBtn');
        const btnText = document.getElementById('btnText');
        const spinner = document.getElementById('spinner');
        
        const timer = setInterval(() => {
          countdown--;
          countdownEl.textContent = countdown;
          if (countdown <= 0) {
            clearInterval(timer);
            submitForm();
          }
        }, 1000);
        
        // A first-time user needs time to type their invite code, so stop
        // the auto-submit countdown as soon as the field is touched
        document.getElementById('inviteCode').addEventListener('focus', () => {
          clearInterval(timer);
          document.querySelector('.auto-redirect').style.display = 'none';
        });

        // Handle manual click
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          clearInterval(timer);
          submitForm();
        });
        
        function submitForm() {
          btnText.style.display = 'none';
          spinner.style.display = 'block';
          btn.disabled = true;
          form.submit();
        }
      </script>
    </body>
    </html>
  `

	return new Response(htmlContent, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Security-Policy':
				"default-src 'self' 'unsafe-inline'; img-src https: data:;",
		},
	})
}

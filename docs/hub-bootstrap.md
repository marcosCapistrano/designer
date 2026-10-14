# Hub server bootstrap

This runbook puts the hub (`apps/server`) on one Hetzner server with Ubuntu 24.04. The hub is reachable only over Tailscale, Claude Code runs on your Claude subscription (never an API key), and secrets are systemd encrypted credentials. Every step is safe to re-run.

Scripts live in `ops/hub/`: `bootstrap.sh` (server setup), `set-secret.sh` (stores one secret), `check-claude.sh` (checks the Claude login), `hub.service` (the systemd unit) and `hub.env.example` (non-secret settings).

1. **Create the server**
   - Hetzner Cloud Console → Add server: Ubuntu 24.04, **CX32** (4 vCPU, 8 GB; 4 GB is the minimum), with your SSH key.
   - In the Tailscale admin console:
     - Enable **MagicDNS** and **HTTPS Certificates** (DNS page).
     - Create a one-off **auth key** (Settings → Keys).
   - Create a GitHub **fine-grained token** for your app repos with these permissions: Contents read/write, Pull requests read/write, Checks read, Commit statuses read, Metadata read.

2. **Run the bootstrap** from your laptop clone. The GitHub token is typed at a prompt and sent over stdin, so it never appears on a command line:
   ```bash
   scp ops/hub/bootstrap.sh root@<public-ip>:/root/
   read -rs -p 'GitHub token: ' GH; echo
   printf '%s\n' "$GH" | ssh root@<public-ip> 'IFS= read -r GITHUB_TOKEN; export GITHUB_TOKEN; TS_AUTHKEY=tskey-auth-… bash /root/bootstrap.sh'
   unset GH
   ```
   `TS_AUTHKEY` is a one-off Tailscale auth key. The bootstrap passes it once to `tailscale up` and does not store it. Once the server has joined the tailnet, revoke the key in the Tailscale admin console if it is still listed.
   The bootstrap also runs `tailscale serve --bg --https=443 http://127.0.0.1:8787`, which publishes the hub on your tailnet with a Tailscale HTTPS certificate. The hub itself listens only on 127.0.0.1.

3. **Close public SSH**, after `ssh root@hub` over Tailscale works: `sudo ufw delete allow OpenSSH`. Also remove port 22 from any Hetzner Cloud Firewall.

4. **Log Claude Code in with your subscription** (never an API key):
   ```bash
   sudo -u hub -H /var/lib/hub/.local/bin/claude setup-token
   ```
   - It prints a URL. Open it on your laptop or tablet, sign in with the Claude account that has the subscription, and paste the code back at `Paste code here if prompted`.
   - Copy the printed token, then run `sudo /opt/hub/ops/hub/set-secret.sh CLAUDE_CODE_OAUTH_TOKEN` and paste it.
   - The token lasts one year. Repeat this step to renew it.

5. **Set the passphrase** you will type on the tablet (≥ 12 characters):
   ```bash
   read -rs -p 'Hub passphrase: ' P; echo; printf '%s' "$P" | sudo -u hub -H pnpm --silent --dir /opt/hub -F @hub/server hash-passphrase | sudo /opt/hub/ops/hub/set-secret.sh HUB_PASSPHRASE_HASH; unset P
   ```

6. **Set the GitHub owner:** run `sudo nano /etc/hub/hub.env` and set `GITHUB_OWNER=<your GitHub user>`. If the bootstrap ran without `GITHUB_TOKEN`, also run `sudo /opt/hub/ops/hub/set-secret.sh GITHUB_TOKEN`.

7. **Check that Claude uses the subscription:**
   ```bash
   sudo systemd-run --wait --pipe --quiet -p User=hub -p LoadCredentialEncrypted=CLAUDE_CODE_OAUTH_TOKEN /opt/hub/ops/hub/check-claude.sh
   ```
   It must print `OK`. The script unsets `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` before it runs Claude.

8. **Clone app repos** (one per app). The GitHub header reaches git through its environment, and the token is typed at a prompt:
   ```bash
   read -rs -p 'GitHub token: ' T; echo
   printf 'AUTHORIZATION: basic %s\n' "$(printf 'x-access-token:%s' "$T" | base64 -w0)" \
     | sudo -u hub -H bash -c '
         IFS= read -r header
         cd /var/lib/hub/apps
         GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader GIT_CONFIG_VALUE_0="$header" git clone https://github.com/<owner>/<app>.git
       '
   unset T
   ```

9. **Start the hub:**
   - `sudo systemctl start hub && journalctl -u hub -n 20` shows `Hub listening on http://127.0.0.1:8787`.
   - `curl -s http://127.0.0.1:8787/api/health` prints `{"ok":true}`.

10. **On the tablet:**
    - Install Tailscale and join the tailnet.
    - Open `https://hub.<tailnet>.ts.net` in Chrome and unlock with the passphrase.
    - Menu → **Add to Home screen**.

11. **Update later:**
    `sudo -u hub -H bash -c 'cd /opt/hub && git pull --ff-only && pnpm install --frozen-lockfile && pnpm -F @hub/client build' && sudo systemctl restart hub`

12. **Known limits**
    Claude runs as the same Unix user as the hub. The deploy guard is a tool policy, not a sandbox.

    Secrets are encrypted with the systemd host key (Hetzner CX servers have no TPM).

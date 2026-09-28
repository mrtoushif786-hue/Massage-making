# WhatsApp x Gemini Bot

Teen tarike se chal sakta hai: **Codespaces** (test), **Railway** (24x7), **Render** (24x7, paid disk).

## Common
- Auto-reply (Gemini, fun/serious tone), scheduled messages, keyword rules, khas numbers ki tone, plugins (`plugins/`), blocked numbers, quiet hours, reply limit, error email (Web3Forms).
- Apne hi chat me `!pause`, `!resume`, `!status`.

## 1) Codespaces (terminal menu, testing ke liye)
1. GitHub par private repo -> Code > Codespaces > Create.
2. `npm start` -> Gemini key, phone number, Web3Forms key (skip = Enter).
3. Enter = aage, Enter Enter (jaldi) = menu.
4. Terminal ka link Chrome me kholo, QR/pairing code se link karo.
Codespace idle par band hota hai, to bot bhi ruk jata hai.

## 2) Railway (24x7)
1. New Project > Deploy from GitHub repo (`railway.json` + `Dockerfile` apne aap use hote hain).
2. Variables: `GEMINI_API_KEY`, `PHONE_NUMBER`, `ADMIN_PASSWORD`, `WEB3FORMS_KEY` (optional), `TZ=Asia/Kolkata`.
3. **Volume banao, mount path `/data`** (bina iske restart par WhatsApp link ud jata hai).
4. Settings > Networking > Generate Domain. Us link par QR/pairing code se link karo.

## 3) Render (24x7)
1. New > Blueprint > repo chuno (`render.yaml` use hota hai), ya Web Service (Docker) manually.
2. Plan **Starter ya upar** + Disk mount path `/data`. Free plan me disk nahi milti aur 15 min baad so jata hai, to WhatsApp link baar-baar udega.
3. Env vars: `GEMINI_API_KEY`, `PHONE_NUMBER`, `ADMIN_PASSWORD`, `WEB3FORMS_KEY` (optional).
4. Deploy ke baad Render ka URL kholo, link karo.

## Hosting par settings badalna
`https://<tumhara-link>/admin` (username kuch bhi, password = `ADMIN_PASSWORD`). Yahan JSON me sab settings hain, Save karte hi lagu.

## Unlink
Phone se Linked devices > bot ko Log out karo. Bot session khud hata dega aur restart ke baad naya QR dikhayega.

Secrets (`config.json`, `auth/`, keys) GitHub par commit mat karo; `.gitignore` me hain.

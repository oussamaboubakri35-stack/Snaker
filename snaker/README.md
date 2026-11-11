# Snaker

Portfolio site for design and video editing: frontend, backend and an admin panel in one folder.
No dependencies. You only need Node.js 18 or newer.

## Run it

Open this folder in Antigravity (or any editor), open a terminal, and run:

    npm start

Then open:

- Site: http://localhost:3000
- Admin: http://localhost:3000/admin/

The first time, the admin password is `snaker123`. Change it right away:

    ADMIN_PASSWORD="your-strong-password" npm start

On Windows PowerShell:

    $env:ADMIN_PASSWORD="your-strong-password"; npm start

## Add your work

1. Go to /admin/ and log in.
2. Projects tab: fill in title, type, year and description.
3. Upload a cover image, then either upload a video file (MP4 recommended, up to 500 MB) or paste a YouTube / Vimeo link.
4. Press Add project. It is live on the site immediately.
5. Delete the four sample projects when you have your own.

The Profile tab edits your headline, intro, about text, tools, email and social links.
The Messages tab shows everything sent through the contact form.

## What is where

    server.js            backend: API, login, uploads, contact form, static files
    public/index.html    the site
    public/css/          styles (colors and fonts are the variables at the top of style.css)
    public/js/app.js     site logic
    public/admin/        admin panel
    data/db.json         all your content (created on first run)
    public/uploads/      uploaded covers and videos

Back up the `data/` and `public/uploads/` folders to back up the whole site.

## Change the look

Open `public/css/style.css`. The palette and font are at the very top:

    --paper, --ink, --muted, --line   neutrals
    --accent                          the snake green
    --font                            Schibsted Grotesk

The Services text is in `public/index.html`.

## Optional settings

    PORT=8080              use another port
    SESSION_SECRET=...     fixed login-signing key (otherwise created in data/secret.key)
    NOTIFY_WEBHOOK=...     Discord or Slack webhook URL, pinged on each new contact message
    NODE_ENV=production    set this when the site is served over HTTPS

## Putting it online

Any host that runs Node works (Render, Railway, Fly.io, a VPS). Set `ADMIN_PASSWORD` and
`NODE_ENV=production`, start with `node server.js`, and keep `data/` and `public/uploads/`
on a persistent disk or volume, otherwise your content resets on every deploy.

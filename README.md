# Portfolio

A single-page portfolio site. Plain HTML/CSS/JS — no build step.

## Customize

Open `index.html` and replace anything in `[BRACKETS]`:

- `[YOUR NAME]`, `[YOUR ROLE]` — top of file (title) + nav logo + footer
- Hero bio paragraphs
- Experience cards (3 templated)
- Projects (3 templated)
- Skills (6 categories, edit pills)
- Education + Certifications
- Contact email
- Social URLs (LinkedIn, GitHub, X)

To change the typewriter words on the hero, edit `TYPEWRITER_WORDS` at the top of `script.js`.

To tweak colors, edit the CSS variables at the top of `styles.css` (`--accent-1`, `--accent-2`, etc.).

## Assets

- `./assets/profile.jpg` — your headshot (~600x600 recommended)
- `./assets/resume.pdf` — your resume (linked from the Resume button)

## Preview locally

Any static server works. For example:

```
npx serve .
```

Then open the URL it prints.

## Deploy to Vercel

1. Push this folder to a GitHub repo.
2. Go to https://vercel.com/new, import the repo.
3. Framework preset: **Other**. Output directory: `./`. Click Deploy.

Or via CLI:

```
npm i -g vercel
vercel
```

# proofofreason.com

One page, three files, no JavaScript. A Cloudflare Worker with static assets: `site/public/` is the
whole site and there is no Worker script, so nothing runs on a request but the asset server.

| File | What it is |
| --- | --- |
| `site/public/index.html` | the page. Every fact on it is literal and checked by a test. |
| `site/public/style.css` | the DJZS token block, copied from https://djzs.ai/style.css, with the source named in a comment. |
| `site/public/favicon.svg` | the phosphor prompt mark, 292 bytes. |
| `site/wrangler.toml` | account, custom domain, assets directory. No secrets, no bindings. |
| `site/test/site.test.ts` | the brand and content checks, run by `pnpm -r test`. |

## Check before deploying

```sh
cd ~/proof-of-reason/site
pnpm install
pnpm test
```

Expected: every test passes, including the weight check, which prints the byte count of each file.
The suite refuses a page that grows a script tag, an em dash, a second font family, a rounded corner,
a saturated colour outside PASS, WAIT and FAIL, or an address that does not match the deployment.

## Deploy

One command, run from `site/`:

```sh
cd ~/proof-of-reason/site
pnpm exec wrangler login        # once per machine
pnpm exec wrangler deploy
```

`wrangler deploy` reads `wrangler.toml`, uploads `public/`, and attaches the custom domain
`proofofreason.com` on account `b4223803d1bd8d0ffb0136a064a0fb16`. `workers_dev = false`, so there is
no `*.workers.dev` URL to leak.

First deploy only: Cloudflare creates the DNS record for `proofofreason.com` as part of attaching the
Custom Domain. If a record for the apex already exists, delete it in the dashboard first or the
deploy fails, the same way `api.proofofreason.com` behaves in `docs/DEPLOY_RUNBOOK.md` step 7.

## Verify after deploying

```sh
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://proofofreason.com/
curl -s https://proofofreason.com/ | grep -c '<script'
curl -s -o /dev/null -w '%{size_download}\n' https://proofofreason.com/
curl -s -o /dev/null -w '%{http_code}\n' https://proofofreason.com/style.css
curl -s -o /dev/null -w '%{http_code}\n' https://proofofreason.com/nothing-here
```

Expected: `301 https://proofofreason.com/` (Always Use HTTPS), `0` script tags, a body under 16000
bytes, `200` for the stylesheet, and `404` for anything else.

The body limit was 12000 bytes until 2026-09-27, when the page gained the plain-language half that
sits above the "For developers" line. The page is 13.4 KB at that rewrite. It was 15000 until
2026-09-29, when the failures paragraph was rewritten with every case named and dated and its source
line recorded, taking the page to 15.4 KB. The number is no longer only documented here:
`site/test/site.test.ts` asserts `index.html` is under the same 16000, so this line and the suite
cannot disagree. Raising it again means editing both.

## When a fact on the page changes

The page states addresses, an agent id, a hash and three dates. They are duplicated in
`site/test/site.test.ts` on purpose: change one and the test fails until both are changed, which is
the point. The addresses were checked on chain before first publication: the gate's `vault()` and
`validator()` match the vault and validator listed, the registry's `identityRegistry()` matches the
identity registry listed, and `ownerOf(10258)` returns an owner.

The agent compliance page is published as a pattern rather than a live link because the indexer
deploys on 28 September (docs/ENVIO.md, "The 28 September rule"). When it is live, the link can point
at a real gate address; the pattern stays correct either way.

# Strand architecture diagrams

| File | What it shows |
|---|---|
| [strand-data-model.drawio](strand-data-model.drawio) | The PostgreSQL schema: 28 tables with columns, keys and relationships, grouped by domain. One page. |
| [strand-aws-architecture.drawio](strand-aws-architecture.drawio) | Page 1: production on AWS (edge, VPC, EKS, Aurora, regional services, operations, CI/CD, numbered request flows). Page 2: disaster-recovery region, recovery targets, where data lives, and the path from today's setup to the target. |

Both are standard draw.io files (uncompressed XML, no external images), built with draw.io's own AWS icon set.

## Putting them in Confluence (draw.io plugin)

Pick one:

1. **Attach and open.** On the page, *Insert > draw.io Diagram* (or the `/draw.io` macro), then *File > Import from > Device* and choose the `.drawio` file. Both pages of the AWS file come with it (tabs at the bottom).
2. **Paste the XML.** Open the file in a text editor, copy everything. In the draw.io editor choose *Extras > Edit Diagram*, replace the content, press *OK*.
3. **Upload the file as an attachment** and use the macro's *Upload a diagram* option if your Confluence has it.

Tips: use *View > Page View* off and *Fit* to zoom out; the data model is wide (about 2400 x 2000), so give it a full-width Confluence page layout. I could not test inside your Confluence, but the files open in draw.io itself, which is what the plugin embeds.

## Reading the AWS diagram

- **Solid** = the application code for it exists today. **Dashed red, tagged PLANNED** = application work not built yet (queue workers, Redis, OpenSearch, SES mail, scheduled jobs, GitHub install flow).
- **Every AWS resource is target state.** Nothing is provisioned yet; today the app runs on Vercel (web), Render (API) and Neon (database).
- Numbered coloured lines are the request flows; the legend on page 1 explains each.
- **Placeholders to confirm:** the region (drawn as ap-south-1), instance sizes (Aurora db.r7g.2xlarge, ElastiCache 2 shards x 2 nodes, 6 to 60 API pods), and the RPO/RTO table on page 2.
- One detail worth knowing: live updates use Postgres LISTEN/NOTIFY, which needs a direct connection to the Aurora writer; it cannot go through RDS Proxy.

## Regenerating

The diagrams are generated, so they stay in step with the code:

```bash
npm run diagrams          # rewrites both .drawio files
npm test                  # fails if a .drawio file is stale or inconsistent with the migrations
```

- `scripts/diagrams/gen-data-model.mjs` reads `supabase/migrations/*.sql` (through `schema.mjs`). A schema change means re-running it, not redrawing.
- `scripts/diagrams/gen-aws.mjs` is the architecture; edit the component lists there.
- `scripts/diagrams/drawio.mjs` is the small XML builder; AWS icon names are checked against `aws4-names.txt` (draw.io's own list, refresh with `scripts/diagrams/refresh-icons.mjs`), so a misspelt icon fails the build instead of rendering as an empty box.
- `scripts/diagrams/render.mjs <file> <outDir> [page]` renders a page to PNG with headless Chrome and draw.io's viewer, for a visual check.

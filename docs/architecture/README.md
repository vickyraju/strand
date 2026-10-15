# jira-build architecture diagrams

| File | What it shows |
|---|---|
| [jira-build-data-model.drawio](jira-build-data-model.drawio) | The PostgreSQL schema of the core product: 22 tables with columns, keys and relationships, grouped by domain. One page. |
| [jira-build-aws-architecture.drawio](jira-build-aws-architecture.drawio) | Page 1: how the application is deployed on AWS in production and which AWS service does what (edge, VPC, EKS, Aurora, regional services, operations and security, build and deploy, numbered request flows). Page 2: the disaster-recovery region, recovery targets, and where data lives. |

Both are standard draw.io files (uncompressed XML, no external images) built with draw.io's own AWS icon set.

## Putting them in Confluence (draw.io plugin)

Pick one:

1. **Import the file.** On the page, *Insert > draw.io Diagram* (or the `/draw.io` macro), then *File > Import from > Device* and choose the `.drawio` file. Both pages of the AWS file come with it (tabs at the bottom).
2. **Paste the XML.** Open the file in a text editor and copy everything. In the draw.io editor choose *Extras > Edit Diagram*, replace the content, press *OK*.
3. **Attach the file** and use the macro's *Upload a diagram* option if your Confluence has it.

The data model is wide (about 2400 x 1900), so give it a full-width page layout. I could not test inside Confluence itself, but the files open in draw.io, which is what the plugin embeds.

## About the AWS diagram

- Scope is the deployment only: which AWS services run the application and what each one is for. Anything outside AWS other than the end users is left out on purpose.
- It is the target production design for the workload (about 40k users, about 10k concurrent): CloudFront + S3 for the web app, EKS for the API and background workers, Aurora PostgreSQL behind RDS Proxy, ElastiCache, SQS, S3 attachments, SES, EventBridge Scheduler, KMS and Secrets Manager, and a second region as a pilot-light DR site.
- **Placeholders to confirm:** the region (drawn as ap-south-1), instance sizes (Aurora db.r7g.2xlarge, ElastiCache 2 shards x 2 nodes, 6 to 60 API pods), and the recovery-target table on page 2.
- Live updates use PostgreSQL LISTEN/NOTIFY, which needs a direct connection to the Aurora writer; it cannot go through RDS Proxy. The diagram shows that path separately.
- Not drawn because Postgres full-text search is enough at this size: a search cluster. It can be added if search outgrows the database.

## About the data model

The GitHub integration tables (`integrations`, `repositories`, `dev_entities`, `dev_links`, `webhook_deliveries`, `user_identities`) exist in the database migrations but are left out here, because that feature is paused. To include them, remove the `OMIT` list in `scripts/diagrams/gen-data-model.mjs`.

## Regenerating

```bash
npm run diagrams          # rewrites both .drawio files
npm test                  # fails if a .drawio file is stale or inconsistent with the migrations
```

- `scripts/diagrams/gen-data-model.mjs` reads `supabase/migrations/*.sql` through `schema.mjs`. A schema change means re-running it, not redrawing.
- `scripts/diagrams/gen-aws.mjs` is the architecture; edit the component lists there.
- `scripts/diagrams/drawio.mjs` is the small XML builder. AWS icon names are checked against `aws4-names.txt` (draw.io's own list; refresh with `refresh-icons.mjs`), so a misspelt icon fails the build instead of rendering as an empty box.
- `scripts/diagrams/render.mjs <file> <outDir> [page]` renders a page to PNG with headless Chrome and draw.io's viewer, for a visual check.

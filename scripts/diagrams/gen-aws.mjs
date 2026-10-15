// Builds docs/architecture/strand-aws-architecture.drawio (2 pages).   node scripts/diagrams/gen-aws.mjs
// Page 1: production in the primary region. Page 2: disaster-recovery region and supporting tables.
import { writeFileSync } from 'node:fs'
import { Page, drawioFile, AWS, flow } from './drawio.mjs'

const BLUE = '#1F6FB2', ORANGE = '#D4781A', GREEN = '#2E7D32', PURPLE = '#7B3FB5', TEAL = '#0E8088', RED = '#B85450', AZURE = '#0078D4', GREY = '#6B7280'
const br = (...lines) => lines.join('<br>')

// ───────────────────────────── Page 1: production ─────────────────────────────
const p1 = new Page('1 · Production (primary region)', { width: 2500, height: 1540 })

p1.text('1', 20, 14, 1800, 70, `<b style="font-size:26px">Strand on AWS: production architecture</b><br><span style="font-size:12px;color:#545B64">Target state. React SPA behind CloudFront; Node.js API on EKS; Aurora PostgreSQL as the system of record; Microsoft Entra ID for sign-in and provisioning. Dashed red = needs application work that is not built yet.</span>`, { noOverlap: true })

// ── Outside AWS ──
// The users icon sits at the same height as CloudFront and the ALB (y = 428 on the page), so the main request path is one straight line.
const ext = p1.panel('1', 20, 100, 300, 650, 'Outside AWS', { dashed: true, stroke: '#879196', size: 13 })
p1.text(ext, 30, 50, 240, 80, br('<b>Microsoft Entra ID</b>', 'OIDC sign-in (PKCE) · JWT with oid', 'SCIM 2.0 user provisioning'), { fill: AZURE, color: '#ffffff', stroke: AZURE, align: 'center', valign: 'middle', size: 11, id: 'entra' })
p1.aws(ext, 'users', AWS.ink, 122, 300, br('End users', '~40k · ~10k concurrent'), { shape: true, id: 'users' })
p1.text(ext, 30, 420, 240, 64, br('<b>GitHub</b>', 'signed webhooks (PR, push, branch)', '<font color="#B85450"><b>PLANNED</b></font>'), { fill: '#FFFFFF', stroke: RED, dashed: true, align: 'center', valign: 'middle', size: 11, id: 'gh' })
p1.text(ext, 30, 500, 240, 52, br('<b>E-mail recipients</b>', 'notifications and digests'), { fill: '#FFFFFF', stroke: '#879196', align: 'center', valign: 'middle', size: 11, id: 'email' })
p1.text(ext, 30, 570, 240, 64, br('<b>Operators</b>', 'kubectl / console via IAM Identity Center'), { fill: '#FFFFFF', stroke: '#879196', align: 'center', valign: 'middle', size: 11, id: 'operators' })

// ── CI/CD (outside AWS) ──
const ci = p1.panel('1', 20, 780, 300, 240, 'CI/CD and infrastructure as code', { dashed: true, stroke: '#879196', size: 13 })
p1.text(ci, 30, 44, 240, 64, br('<b>GitHub Actions</b>', 'build · test · scan · push image', 'bump GitOps manifest'), { fill: '#FFFFFF', stroke: '#879196', align: 'center', valign: 'middle', size: 11, id: 'gha' })
p1.text(ci, 30, 122, 240, 44, br('<b>Terraform (or CDK)</b>', 'all AWS resources as code'), { fill: '#FFFFFF', stroke: '#879196', align: 'center', valign: 'middle', size: 11, id: 'tf' })
p1.text(ci, 30, 178, 240, 52, 'Argo CD (in the cluster) pulls manifests. Database migrations run as a pre-deploy Kubernetes Job.', { size: 10, color: '#545B64', noOverlap: true })

// ── Legend ──
const leg = p1.panel('1', 20, 1050, 300, 430, 'Legend', { stroke: '#879196', size: 13 })
const lg = [
  ['#1F6FB2', '1', 'Static app: Route 53, CloudFront, S3'],
  [ORANGE, '2', 'API calls: CloudFront, WAF, ALB, pods (/api/v1, SSE, SCIM, webhook)'],
  [GREEN, '3', 'SQL: writes through RDS Proxy; reads from the reader endpoint'],
  [PURPLE, '4', 'Live updates: LISTEN/NOTIFY on the writer endpoint (not RDS Proxy)'],
  [TEAL, '5', 'Attachments: browser to S3 with presigned URLs; bytes skip the API'],
  [RED, '6', 'Async jobs: pods and SQS workers (planned)'],
  [AZURE, '7', 'Identity: Entra sign-in; SCIM provisioning'],
  [GREY, '8', 'GitHub webhooks (planned)'],
  [GREY, '9', 'Telemetry: pods to CloudWatch and X-Ray'],
]
lg.forEach(([c, n, t], i) => p1.text(leg, 12, 34 + i * 33, 276, 32, `<font color="${c}"><b>━━ ${n}</b></font>&nbsp; ${t}`, { size: 10, noOverlap: true }))
p1.text(leg, 12, 34 + lg.length * 33 + 8, 276, 80, br('<b>Solid</b> = application code exists today.', '<b><font color="#B85450">Dashed red</font></b> = planned application work. All AWS resources shown are target state; none are provisioned yet.'), { size: 10, noOverlap: true })

// ── AWS Cloud ──
const cloud = p1.group('1', 'group_aws_cloud_alt', 360, 100, 2060, 1290, 'AWS Cloud', { stroke: AWS.ink, id: 'cloud' })

// Edge services (global)
const edge = p1.panel(cloud, 20, 60, 260, 600, 'Edge (global services)', { stroke: '#8C4FFF', size: 12, font: '#8C4FFF' })
p1.aws(edge, 'route_53', AWS.net, 30, 44, br('Route 53', 'DNS, health checks'), { id: 'r53' })
p1.aws(edge, 'certificate_manager', AWS.sec, 174, 44, br('ACM', 'TLS certificates'), { shape: true, id: 'acm' })
p1.aws(edge, 'waf', AWS.sec, 30, 150, br('AWS WAF', 'on CloudFront'), { id: 'waf' })
p1.aws(edge, 'shield', AWS.sec, 174, 150, br('Shield', 'Advanced'), { id: 'shield' })
p1.aws(edge, 'cloudfront', AWS.net, 102, 240, br('CloudFront', 'static app + API origin'), { id: 'cf' })
p1.aws(edge, 's3', AWS.storage, 102, 400, br('S3: web app', 'private, OAC'), { id: 's3web' })

// Primary region
const region = p1.group(cloud, 'group_region', 310, 60, 1700, 1000, 'Primary region (placeholder: ap-south-1)', { dashed: true, stroke: '#147EBA', id: 'region' })
const vpc = p1.group(region, 'group_vpc2', 20, 50, 1010, 930, 'Strand VPC · 10.0.0.0/16 · 3 Availability Zones (a · b · c)', { stroke: '#8C4FFF', id: 'vpc' })

// Public tier
const pub = p1.panel(vpc, 20, 60, 240, 520, 'Public subnets (a · b · c)', { stroke: '#248814', fill: '#F2F9F0', size: 12, font: '#248814' })
p1.aws(pub, 'internet_gateway', AWS.net, 92, 40, br('Internet', 'gateway'), { shape: true, id: 'igw' })
p1.aws(pub, 'application_load_balancer', AWS.net, 92, 130, br('Application', 'Load Balancer', 'spans 3 AZs'), { shape: true, id: 'alb' })
;['a', 'b', 'c'].forEach((z, i) => p1.aws(pub, 'nat_gateway', AWS.net, 18 + i * 72, 380, `NAT ${z}`, { shape: true, size: 48, id: `nat_${z}` }))
p1.text(pub, 10, 450, 220, 60, 'Only CloudFront can reach the ALB (managed prefix list). SSE needs a long idle timeout.', { size: 10, color: '#545B64', noOverlap: true })

// App tier: EKS
const app = p1.panel(vpc, 290, 60, 700, 520, 'Private app subnets (a · b · c)', { stroke: '#147EBA', fill: '#F1F7FB', size: 12, font: '#147EBA' })
const eks = p1.panel(app, 20, 44, 660, 460, 'Amazon EKS · cluster strand-prod', { stroke: AWS.compute, size: 12, font: AWS.compute, id: 'eks' })
p1.aws(eks, 'eks', AWS.compute, 14, 34, '', { size: 44, id: 'eks_icon' })
p1.text(eks, 70, 32, 580, 52, br('<b>Control plane (AWS-managed)</b>', 'Add-ons: VPC CNI · CoreDNS · AWS Load Balancer Controller · Karpenter · KEDA · ADOT collector · Argo CD'), { size: 10, noOverlap: true })
;['a', 'b', 'c'].forEach((z, i) => {
  const az = p1.panel(eks, 14 + i * 215, 96, 205, 250, `AZ ${z} · Karpenter nodes (EC2)`, { stroke: '#147EBA', dashed: true, size: 10, bold: false })
  p1.text(az, 12, 40, 181, 70, br('<b>strand-api</b>', 'Fastify · REST · SSE', 'SCIM · GitHub webhook'), { fill: '#E8F1FB', stroke: BLUE, align: 'center', valign: 'middle', size: 10, id: `pod_api_${z}` })
  p1.text(az, 12, 130, 181, 70, br('<b>strand-worker</b>', 'queue consumers: rules,', 'notifications, e-mail', '<font color="#B85450"><b>PLANNED</b></font>'), { fill: '#FFFFFF', stroke: RED, dashed: true, align: 'center', valign: 'middle', size: 10, id: `pod_wrk_${z}` })
})
p1.text(eks, 14, 362, 632, 84, br('<b>Scaling:</b> HPA keeps 6 to 60 strand-api pods (indicative); KEDA scales strand-worker on SQS queue depth (planned).', '<b>Access:</b> IRSA gives each pod only the AWS permissions it needs; no static keys.', '<b>Spread:</b> topology constraints and PodDisruptionBudgets keep pods in all 3 AZs.'), { size: 10, noOverlap: true })

// Data tier
const data = p1.panel(vpc, 20, 610, 970, 300, 'Private data subnets (a · b · c)', { stroke: '#147EBA', fill: '#F1F7FB', size: 12, font: '#147EBA' })
p1.aws(data, 'rds_proxy', AWS.db, 38, 70, br('RDS Proxy', 'pooling, fast failover'), { shape: true, size: 52, id: 'proxy' })
const aur = p1.panel(data, 150, 40, 480, 244, 'Aurora cluster', { stroke: AWS.db, size: 12, font: AWS.db, id: 'aurora' })
p1.aws(aur, 'aurora', AWS.db, 40, 40, br('Writer', 'AZ a'), { size: 52, id: 'aur_writer' })
p1.aws(aur, 'aurora', AWS.db, 196, 40, br('Reader', 'AZ b'), { size: 52, id: 'aur_r1' })
p1.aws(aur, 'aurora', AWS.db, 352, 40, br('Reader', 'AZ c'), { size: 52, id: 'aur_r2' })
p1.text(aur, 14, 140, 452, 42, br('<b>Cluster endpoint</b>: writes, and LISTEN/NOTIFY for live updates (direct to the writer, not through RDS Proxy)'), { size: 10, fill: '#FDF3FB', stroke: AWS.db, id: 'aur_cluster_ep' })
p1.text(aur, 14, 190, 452, 40, br('<b>Reader endpoint</b>: read-only queries (lists, search, dashboards)'), { size: 10, fill: '#FDF3FB', stroke: AWS.db, id: 'aur_reader' })
const cache = p1.panel(data, 646, 40, 150, 244, 'ElastiCache', { stroke: RED, dashed: true, size: 12, font: RED, id: 'cache_p' })
p1.aws(cache, 'elasticache', AWS.db, 47, 40, br('Redis / Valkey', '<font color="#B85450"><b>PLANNED</b></font>'), { size: 52, id: 'cache' })
p1.text(cache, 8, 156, 134, 80, 'rate limits, hot project config, pub/sub when more than one pod listens', { size: 10, noOverlap: true })
const os = p1.panel(data, 806, 40, 150, 244, 'OpenSearch', { stroke: RED, dashed: true, size: 12, font: RED, id: 'os_p' })
p1.aws(os, 'elasticsearch_service', AWS.net, 47, 40, br('OpenSearch', '<font color="#B85450"><b>PLANNED</b></font>'), { size: 52, id: 'os' })
p1.text(os, 8, 156, 134, 80, 'only if Postgres full-text search stops being enough', { size: 10, noOverlap: true })

// Regional services (outside the VPC)
const reg = p1.panel(region, 1060, 50, 600, 930, 'Regional services (reached through VPC endpoints)', { stroke: '#879196', size: 12, id: 'regional' })
const svc = [
  ['sqs', AWS.integ, 'SQS', 'job queue + dead-letter queue', true, 'sqs', false],
  ['s3', AWS.storage, 'S3: attachments', 'SSE-KMS · presigned URLs', false, 's3att', false],
  ['eventbridge_scheduler', AWS.integ, 'EventBridge Scheduler', 'due reminders, rank rebalance', true, 'evb', true],
  ['simple_email_service', AWS.sec, 'Amazon SES', 'transactional e-mail', true, 'ses', false],
  ['key_management_service', AWS.sec, 'KMS', 'keys: S3, Aurora, secrets', false, 'kms', false],
  ['secrets_manager', AWS.sec, 'Secrets Manager', 'DB credentials, SCIM token', false, 'sm', false],
  ['parameter_store', AWS.mgmt, 'SSM Parameter Store', 'non-secret config', false, 'ssm', true],
  ['ecr', AWS.compute, 'ECR', 'container images', false, 'ecr', false],
]
svc.forEach(([name, color, l1, l2, planned, id, shape], i) => p1.aws(reg, name, color, 60 + (i % 2) * 280, 70 + Math.floor(i / 2) * 190, br(l1, l2), { planned, id, shape }))
p1.text(reg, 20, 810, 270, 100, br('<b>VPC endpoints</b>', 'S3 (gateway); ECR, Secrets Manager, SSM, SQS, CloudWatch Logs, STS (interface). Calls to AWS services stay off the internet.'), { size: 10, fill: '#FFFFFF', stroke: '#879196', id: 'vpce' })

// Operations & security band
const ops = p1.panel(cloud, 310, 1090, 1700, 170, 'Operations and security', { stroke: '#E7157B', size: 12, font: '#E7157B', id: 'ops' })
const opsIcons = [
  ['cloudwatch_2', AWS.mgmt, 'CloudWatch', 'logs · metrics · alarms', false, 'cw', false],
  ['sns', AWS.integ, 'SNS', 'alarms to on-call', false, 'sns', false],
  ['xray', AWS.mgmt, 'X-Ray', 'traces via ADOT', false, 'xray', false],
  ['cloudtrail', AWS.mgmt, 'CloudTrail', 'API audit trail', false, 'ct', false],
  ['config', AWS.mgmt, 'AWS Config', 'drift and compliance', false, 'cfg', false],
  ['security_hub', AWS.sec, 'Security Hub', 'findings in one place', false, 'sh', false],
  ['guardduty', AWS.sec, 'GuardDuty', 'threats + S3 malware scan (planned)', false, 'gd', false],
  ['single_sign_on', AWS.sec, 'IAM Identity Center', 'staff access', false, 'iic', false],
]
opsIcons.forEach(([n, c, l1, l2, planned, id, shape], i) => p1.aws(ops, n, c, 70 + i * 205, 40, br(l1, l2), { planned, id, shape }))

p1.text('1', 360, 1420, 2060, 60, `<span style="color:#545B64"><b>Indicative sizing (to be confirmed):</b> 3 AZs, NAT gateway per AZ · strand-api 6 to 60 pods · Aurora db.r7g.2xlarge writer + 2 readers · ElastiCache 2 shards × 2 nodes. Region, instance sizes and quotas are placeholders. Nothing here is provisioned yet.</span>`, { size: 11, noOverlap: true })

// ── Flows ──  (absolute page coordinates for waypoints; exit/entry points are fixed so lines run in clear lanes)
const pt = (exitX, exitY, entryX, entryY) => ({ exitX, exitY, entryX, entryY, exitPerimeter: 0, entryPerimeter: 0 })
const f = (n, src, tgt, label, color, o = {}) => p1.edge({ source: src, target: tgt, value: label ? `${n}  ${label}` : '', st: flow(color, { ...(o.pts ?? {}), ...(o.st ?? {}) }), points: o.points ?? [] })
const dash = { dashed: 1, dashPattern: '6 3' }
f(1, 'users', 'cf', 'HTTPS', BLUE, { pts: pt(1, 0.5, 0, 0.5) })
f(1, 'cf', 's3web', 'static app (OAC)', BLUE, { pts: pt(0.5, 1, 0.5, 0) })
p1.edge({ source: 'r53', target: 'cf', value: '', st: flow(GREY, { strokeWidth: 1.2, dashed: 1, dashPattern: '3 3', fontStyle: 0, ...pt(0.5, 1, 0.3, 0) }), points: [[438, 372], [504, 372]] })
f(2, 'cf', 'alb', '/api/v1 · SSE · /scim · webhook', ORANGE, { pts: pt(1, 0.5, 0, 0.5) })
f(2, 'alb', 'eks', 'to pod IPs', ORANGE, { pts: pt(1, 0.5, 0, 0.25) })
f(3, 'eks', 'proxy', 'writes (pooled)', GREEN, { pts: pt(0.15, 1, 0.5, 0), points: [[1099, 788], [774, 788]] })
f(3, 'eks', 'aurora', 'reads (reader endpoint)', GREEN, { pts: pt(0.55, 1, 0.85, 0), points: [[1363, 796], [1268, 796]] })
p1.edge({ source: 'proxy', target: 'aur_writer', st: flow(GREEN, { strokeWidth: 1.5, ...pt(1, 0.5, 0, 0.5) }) })
f(4, 'eks', 'aur_writer', 'LISTEN/NOTIFY (direct)', PURPLE, { pts: pt(0.35, 1, 0.5, 0), st: dash, points: [[1231, 804], [926, 804]] })
f(5, 'users', 's3att', 'presigned PUT/GET: browser to S3 directly', TEAL, { pts: pt(0, 0.5, 0.5, 0), points: [[35, 428], [35, 90], [2098, 90]] })
p1.edge({ source: 'eks', target: 'sqs', value: '6  enqueue ⇄ consume', st: flow(RED, { ...dash, startArrow: 'block', startFill: 1, ...pt(1, 0.12, 0, 0.5) }) })
p1.edge({ source: 'eks', target: 'regional', value: 'IRSA: S3, KMS, Secrets, SES', st: flow(GREY, { strokeWidth: 1.5, dashed: 1, dashPattern: '2 3', ...pt(1, 0.5, 0, 0.5) }) })
f(7, 'users', 'entra', 'OIDC sign-in (PKCE)', AZURE, { pts: pt(0.5, 0, 0.5, 1) })
f(7, 'entra', 'cf', 'SCIM 2.0 to /scim/v2', AZURE, { pts: pt(1, 0.5, 0, 0.15), points: [[345, 190], [345, 410]] })
f(8, 'gh', 'cf', 'webhooks (planned)', GREY, { pts: pt(1, 0.5, 0, 0.85), st: dash, points: [[345, 600], [345, 446]] })
f(9, 'vpc', 'ops', 'telemetry: pods → ADOT collector → CloudWatch, X-Ray', GREY, { pts: pt(0.5, 1, 0.5, 0) })
p1.edge({ source: 'gha', target: 'cloud', value: 'images · GitOps', st: flow(GREY, { strokeWidth: 1.5, ...pt(1, 0.5, 0, 0.586) }) })

// ───────────────────────────── Page 2: disaster recovery and supporting tables ─────────────────────────────
const p2 = new Page('2 · Disaster recovery and data', { width: 2400, height: 1300 })
p2.text('1', 20, 14, 2000, 70, `<b style="font-size:26px">Strand on AWS: disaster recovery (pilot light) and where data lives</b><br><span style="font-size:12px;color:#545B64">A second region keeps the database and files replicated, and the compute scaled down. Failover is a runbook step, not automatic. Targets are indicative and need agreeing.</span>`, { noOverlap: true })

const dr = p2.group('1', 'group_aws_cloud_alt', 20, 100, 1560, 1150, 'AWS Cloud', { stroke: AWS.ink, id: 'cloud2' })
p2.aws(dr, 'route_53', AWS.net, 720, 50, '', { id: 'r53b' })
p2.text(dr, 790, 60, 300, 40, br('<b>Route 53</b>', 'failover routing + health checks'), { size: 11, noOverlap: true })
p2.aws(dr, 'cloudfront', AWS.net, 720, 190, br('CloudFront', 'origin group with failover'), { id: 'cfb' })

// Regions face each other across a 200px gap. The replicated resources (Aurora, S3, ECR, Secrets) sit in the column next to the gap,
// at the same heights in both regions, so every replication arrow is a short straight line that crosses nothing.
const regA = p2.group(dr, 'group_region', 30, 330, 640, 790, 'Region A (primary): serving traffic', { stroke: '#147EBA', id: 'regA' })
const regB = p2.group(dr, 'group_region', 870, 330, 640, 790, 'Region B (DR): pilot light', { stroke: '#D4781A', dashed: true, id: 'regB' })
for (const [reg, tag, warm] of [[regA, 'A', false], [regB, 'B', true]]) {
  const rx = warm ? 60 : 480, lx = warm ? 480 : 60          // replicated column / local column
  p2.aws(reg, 'aurora', AWS.db, rx, 60, br(warm ? 'Aurora secondary' : 'Aurora primary', warm ? 'read-only, replicating' : 'writer + 2 readers'), { id: `aur${tag}` })
  p2.aws(reg, 's3', AWS.storage, rx, 200, br('S3 attachments', warm ? 'replica bucket' : 'source bucket'), { id: `s3${tag}` })
  p2.aws(reg, 'ecr', AWS.compute, rx, 340, br('ECR', warm ? 'replicated images' : 'images'), { id: `ecr${tag}` })
  p2.aws(reg, 'secrets_manager', AWS.sec, rx, 480, br('Secrets Manager', warm ? 'replica secrets' : 'secrets'), { id: `sm${tag}` })
  p2.aws(reg, 'application_load_balancer', AWS.net, lx, 60, 'ALB', { shape: true, id: `alb${tag}` })
  p2.aws(reg, 'eks', AWS.compute, lx, 184, br('EKS', warm ? 'control plane up · nodes at zero' : '3 AZs · autoscaled'), { id: `eks${tag}` })
  p2.aws(reg, 'key_management_service', AWS.sec, lx, 308, br('KMS', 'multi-Region keys'), { id: `kms${tag}` })
  p2.aws(reg, 'sqs', AWS.integ, lx, 432, br('SQS', warm ? 'empty queue' : 'job queue'), { planned: true, id: `sqs${tag}` })
  p2.aws(reg, 'elasticache', AWS.db, lx, 556, br('ElastiCache', warm ? 'cold start' : 'cache'), { planned: true, id: `cache${tag}` })
}
p2.text(regB, 20, 700, 600, 70, br('<b>On failover (runbook):</b> promote the Aurora secondary · scale Karpenter node pools up · point Route 53 and CloudFront at region B · re-enable the SQS workers. Rehearse twice a year.'), { size: 10, noOverlap: true })
p2.text(regA, 20, 700, 600, 70, br('<b>Normal operation:</b> all traffic is served here. Aurora Global Database copies storage to region B (typically under a second). S3 and ECR replication copy files and images.'), { size: 10, noOverlap: true })
const g = (src, tgt, label, color, o = {}) => p2.edge({ source: src, target: tgt, value: label, st: flow(color, o.st ?? {}), points: o.points ?? [] })
g('r53b', 'cfb', '', GREY, { st: { strokeWidth: 1.5, ...pt(0.5, 1, 0.5, 0) } })
g('cfb', 'albA', 'primary origin', BLUE, { st: pt(0, 0.5, 0.5, 0), points: [[138, 318]] })
g('cfb', 'albB', 'failover origin', ORANGE, { st: { ...dash, ...pt(1, 0.5, 0.5, 0) }, points: [[1398, 318]] })
const repl = (a, b, label, color) => g(a, b, label, color, { st: { strokeWidth: 2.5, ...pt(1, 0.5, 0, 0.5) } })
repl('aurA', 'aurB', 'Aurora Global DB', GREEN)
repl('s3A', 's3B', 'S3 replication', TEAL)
repl('ecrA', 'ecrB', 'ECR replication', GREY)
repl('smA', 'smB', 'secret replication', GREY)

// Right column: RPO/RTO, what lives where, today to target
const rt = p2.panel('1', 1620, 100, 760, 300, 'Recovery targets (indicative, to be agreed)', { stroke: '#879196', size: 13 })
const rows = [['Scenario', 'RPO', 'RTO'], ['Pod or node failure', '0', 'seconds (rescheduled)'], ['Availability Zone outage', '0 (Multi-AZ Aurora)', 'about 1 to 2 minutes (failover)'], ['Region outage', 'about 1 minute (Global DB lag)', '30 to 60 minutes (runbook)'], ['Bad deploy', '0', 'minutes (rollback to previous image)'], ['Data corruption / mistake', 'point in time, to the second', 'hours (restore to a new cluster)']]
rows.forEach((r, i) => r.forEach((cell, j) => p2.text(rt, 14 + [0, 270, 500][j], 44 + i * 40, [256, 226, 246][j], 38, i === 0 ? `<b>${cell}</b>` : cell, { size: 10, noOverlap: true })))
const dl = p2.panel('1', 1620, 430, 760, 330, 'Where data lives', { stroke: '#879196', size: 13 })
const lives = [['Aurora PostgreSQL', 'system of record: projects, issues, comments, users, history. Backups + point-in-time recovery; replicated to region B.'], ['S3', 'attachment files. Versioned, encrypted with KMS, replicated to region B.'], ['ElastiCache (planned)', 'ephemeral: rate-limit counters, cached project config. Safe to lose.'], ['SQS (planned)', 'in-flight jobs only. Jobs are retried; the database is the source of truth.'], ['Secrets Manager', 'credentials and tokens. Replicated; rotated on a schedule.']]
lives.forEach(([h, t], i) => p2.text(dl, 14, 44 + i * 56, 732, 54, `<b>${h}.</b> ${t}`, { size: 10, noOverlap: true }))
const tt = p2.panel('1', 1620, 790, 760, 460, 'From today to target', { stroke: '#879196', size: 13 })
const map = [['Web app', 'Vercel', 'CloudFront + S3'], ['API', 'Render (Docker, free plan)', 'EKS (Deployment + HPA)'], ['Database', 'Neon PostgreSQL', 'Aurora PostgreSQL + RDS Proxy'], ['Files', 'S3-compatible bucket (not set up)', 'S3 with presigned URLs'], ['Sign-in', 'dev secret + email header', 'Microsoft Entra ID (OIDC)'], ['Provisioning', 'SCIM endpoint in code, untested', 'Entra ID SCIM 2.0'], ['Background jobs', 'inline in the request', 'SQS + worker pods (planned)'], ['Live updates', 'Postgres LISTEN/NOTIFY', 'same, on the Aurora writer endpoint'], ['Deploy', 'git push → Vercel / Render', 'GitHub Actions → ECR → Argo CD']]
map.forEach((r, i) => r.forEach((cell, j) => p2.text(tt, 14 + [0, 150, 440][j], 44 + i * 40, [136, 280, 306][j], 38, i === 0 || j === 0 ? `<b>${cell}</b>` : cell, { size: 10, noOverlap: true })))
p2.text(tt, 14, 44 + map.length * 40 + 6, 732, 40, 'Same Docker image and the same environment-variable configuration run in both; the database migrations are plain SQL.', { size: 10, color: '#545B64', noOverlap: true })

// ───────────────────────────── Checks and output ─────────────────────────────
const pages = [p1, p2]
const out = new URL('../../docs/architecture/strand-aws-architecture.drawio', import.meta.url)
let bad = 0
for (const p of pages) { const pr = p.problems(); if (pr.length) { bad += pr.length; console.error(`[${p.name}]\n` + pr.join('\n')) } }
if (bad) process.exit(1)
writeFileSync(out, drawioFile(pages, { name: 'Strand AWS architecture' }))
console.log(`wrote strand-aws-architecture.drawio: ${pages.length} page(s), ${pages.reduce((n, p) => n + p.cells.size + p.edges.length, 0)} cells`)

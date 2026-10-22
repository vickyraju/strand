// Builds docs/architecture/jira-build-aws-architecture.drawio (2 pages).   node scripts/diagrams/gen-aws.mjs
// Scope: how the application is deployed on AWS and what each AWS service is used for. Nothing outside AWS except the end users and the build tooling (Jenkins, SonarQube, JFrog Artifactory).
// Page 1: production in the primary region. Page 2: disaster-recovery region, recovery targets, where data lives.
import { writeFileSync } from 'node:fs'
import { Page, drawioFile, AWS, flow } from './drawio.mjs'

const APP = 'jira-build'
const BLUE = '#1F6FB2', ORANGE = '#D4781A', GREEN = '#2E7D32', PURPLE = '#7B3FB5', TEAL = '#0E8088', RED = '#B85450', GREY = '#6B7280'
const br = (...lines) => lines.join('<br>')
const pt = (exitX, exitY, entryX, entryY) => ({ exitX, exitY, entryX, entryY, exitPerimeter: 0, entryPerimeter: 0 })
const dash = { dashed: 1, dashPattern: '6 3' }

// ───────────────────────────── Page 1: production ─────────────────────────────
const p1 = new Page('1 · Production (primary region)', { width: 2500, height: 1680 })

p1.text('1', 20, 14, 2000, 70, `<b style="font-size:26px">${APP} on AWS: production architecture</b><br><span style="font-size:12px;color:#545B64">How the application is deployed and which AWS service does what. Web app served from CloudFront and S3; API and background workers on Amazon EKS; Amazon Aurora PostgreSQL as the system of record.</span>`, { noOverlap: true })

// ── End users (the only thing outside AWS) ──
// The users icon sits at the same height as CloudFront and the ALB, so the main request path is one straight line.
const ext = p1.panel('1', 20, 350, 300, 170, 'Outside AWS', { dashed: true, stroke: '#879196', size: 13 })
p1.aws(ext, 'users', AWS.ink, 122, 50, br('End users', '~40k · ~10k concurrent'), { shape: true, id: 'users' })

// ── Legend ──
const leg = p1.panel('1', 20, 560, 300, 400, 'Request flows', { stroke: '#879196', size: 13 })
const lg = [
  [BLUE, '1', 'Web app: Route 53, CloudFront, S3'],
  [ORANGE, '2', 'API calls: CloudFront, WAF, ALB, API pods'],
  [GREEN, '3', 'SQL: writes via RDS Proxy; reads from the reader endpoint'],
  [PURPLE, '4', 'Live updates: LISTEN/NOTIFY on the writer endpoint (not RDS Proxy)'],
  [TEAL, '5', 'Attachments: browser to S3 with presigned URLs; bytes skip the API'],
  [RED, '6', 'Background jobs: API pods, SQS, worker pods'],
  [GREY, '7', 'Telemetry: pods to CloudWatch and X-Ray'],
]
lg.forEach(([c, n, t], i) => leg && p1.text(leg, 12, 36 + i * 44, 276, 42, `<font color="${c}"><b>━━ ${n}</b></font>&nbsp; ${t}`, { size: 10, noOverlap: true }))
p1.text(leg, 12, 36 + lg.length * 44 + 4, 276, 36, 'Target production design. Sizes are indicative.', { size: 10, color: '#545B64', noOverlap: true })

// ── AWS Cloud ──
const cloud = p1.group('1', 'group_aws_cloud_alt', 360, 100, 2060, 1480, 'AWS Cloud', { stroke: AWS.ink, id: 'cloud' })

// Edge services (global)
const edge = p1.panel(cloud, 20, 60, 260, 600, 'Edge (global services)', { stroke: '#8C4FFF', size: 12, font: '#8C4FFF' })
p1.aws(edge, 'route_53', AWS.net, 30, 44, br('Route 53', 'DNS, health checks'), { id: 'r53' })
p1.aws(edge, 'certificate_manager', AWS.sec, 174, 44, br('ACM', 'TLS certificates'), { shape: true, id: 'acm' })
p1.aws(edge, 'waf', AWS.sec, 30, 150, br('AWS WAF', 'on CloudFront'), { id: 'waf' })
p1.aws(edge, 'shield', AWS.sec, 174, 150, br('Shield', 'Advanced'), { id: 'shield' })
p1.aws(edge, 'cloudfront', AWS.net, 102, 240, br('CloudFront', 'web app + API origin'), { id: 'cf' })
p1.aws(edge, 's3', AWS.storage, 102, 400, br('S3: web app', 'private, OAC'), { id: 's3web' })

// Primary region and VPC
const region = p1.group(cloud, 'group_region', 310, 60, 1700, 1000, 'Primary region (placeholder: ap-south-1)', { dashed: true, stroke: '#147EBA', id: 'region' })
const vpc = p1.group(region, 'group_vpc2', 20, 50, 1010, 930, `${APP} VPC · 10.0.0.0/16 · 3 Availability Zones (a · b · c)`, { stroke: '#8C4FFF', id: 'vpc' })

// Public tier
const pub = p1.panel(vpc, 20, 60, 240, 520, 'Public subnets (a · b · c)', { stroke: '#248814', fill: '#F2F9F0', size: 12, font: '#248814' })
p1.aws(pub, 'internet_gateway', AWS.net, 92, 40, br('Internet', 'gateway'), { shape: true, id: 'igw' })
p1.aws(pub, 'application_load_balancer', AWS.net, 92, 130, br('Application', 'Load Balancer', 'spans 3 AZs'), { shape: true, id: 'alb' })
;['a', 'b', 'c'].forEach((z, i) => p1.aws(pub, 'nat_gateway', AWS.net, 18 + i * 72, 380, `NAT ${z}`, { shape: true, size: 48, id: `nat_${z}` }))
p1.text(pub, 10, 450, 220, 60, 'Only CloudFront can reach the ALB (managed prefix list). Long idle timeout for live-update streams.', { size: 10, color: '#545B64', noOverlap: true })

// App tier: EKS
const app = p1.panel(vpc, 290, 60, 700, 520, 'Private app subnets (a · b · c)', { stroke: '#147EBA', fill: '#F1F7FB', size: 12, font: '#147EBA' })
const eks = p1.panel(app, 20, 44, 660, 460, `Amazon EKS · cluster ${APP}-prod`, { stroke: AWS.compute, size: 12, font: AWS.compute, id: 'eks' })
p1.aws(eks, 'eks', AWS.compute, 14, 34, '', { size: 44, id: 'eks_icon' })
p1.text(eks, 70, 32, 580, 52, br('<b>Control plane (AWS-managed)</b>', 'Add-ons: VPC CNI · CoreDNS · AWS Load Balancer Controller · Karpenter · KEDA · ADOT collector'), { size: 10, noOverlap: true })
;['a', 'b', 'c'].forEach((z, i) => {
  const az = p1.panel(eks, 14 + i * 215, 96, 205, 250, `AZ ${z} · Karpenter nodes (EC2)`, { stroke: '#147EBA', dashed: true, size: 10, bold: false })
  p1.text(az, 12, 40, 181, 70, br(`<b>${APP}-api</b>`, 'REST API · live-update streams'), { fill: '#E8F1FB', stroke: BLUE, align: 'center', valign: 'middle', size: 10, id: `pod_api_${z}` })
  p1.text(az, 12, 130, 181, 70, br(`<b>${APP}-worker</b>`, 'queue consumers: automations,', 'notifications, e-mail, imports'), { fill: '#FFFFFF', stroke: '#879196', align: 'center', valign: 'middle', size: 10, id: `pod_wrk_${z}` })
})
p1.text(eks, 14, 362, 632, 84, br('<b>Scaling:</b> HPA keeps 6 to 60 API pods (indicative); KEDA scales the workers on SQS queue depth.', '<b>Access:</b> IRSA gives each pod only the AWS permissions it needs; no static keys.', '<b>Spread:</b> topology constraints and PodDisruptionBudgets keep pods in all 3 AZs.'), { size: 10, noOverlap: true })

// Data tier
const data = p1.panel(vpc, 20, 610, 970, 300, 'Private data subnets (a · b · c)', { stroke: '#147EBA', fill: '#F1F7FB', size: 12, font: '#147EBA' })
p1.aws(data, 'rds_proxy', AWS.db, 38, 70, br('RDS Proxy', 'pooling, fast failover'), { shape: true, size: 52, id: 'proxy' })
const aur = p1.panel(data, 150, 40, 480, 244, 'Aurora cluster', { stroke: AWS.db, size: 12, font: AWS.db, id: 'aurora' })
p1.aws(aur, 'aurora', AWS.db, 40, 40, br('Writer', 'AZ a'), { size: 52, id: 'aur_writer' })
p1.aws(aur, 'aurora', AWS.db, 196, 40, br('Reader', 'AZ b'), { size: 52, id: 'aur_r1' })
p1.aws(aur, 'aurora', AWS.db, 352, 40, br('Reader', 'AZ c'), { size: 52, id: 'aur_r2' })
p1.text(aur, 14, 140, 452, 42, br('<b>Cluster endpoint</b>: writes, and LISTEN/NOTIFY for live updates (direct to the writer, not through RDS Proxy)'), { size: 10, fill: '#FDF3FB', stroke: AWS.db, id: 'aur_cluster_ep' })
p1.text(aur, 14, 190, 452, 40, br('<b>Reader endpoint</b>: read-only queries (lists, search, dashboards)'), { size: 10, fill: '#FDF3FB', stroke: AWS.db, id: 'aur_reader' })
const cache = p1.panel(data, 646, 40, 310, 244, 'ElastiCache', { stroke: AWS.db, size: 12, font: AWS.db, id: 'cache_p' })
p1.aws(cache, 'elasticache', AWS.db, 127, 40, br('Redis / Valkey', 'Multi-AZ'), { size: 52, id: 'cache' })
p1.text(cache, 14, 156, 282, 70, 'API rate limiting, cached project configuration, and fan-out of live-update events across API pods', { size: 10, noOverlap: true })

// Regional services (outside the VPC)
const reg = p1.panel(region, 1060, 50, 600, 930, 'Regional services (reached through VPC endpoints)', { stroke: '#879196', size: 12, id: 'regional' })
const svc = [
  ['sqs', AWS.integ, 'SQS', 'job queue + dead-letter queue', 'sqs', false],
  ['s3', AWS.storage, 'S3: attachments', 'SSE-KMS · presigned URLs', 's3att', false],
  ['eventbridge_scheduler', AWS.integ, 'EventBridge Scheduler', 'due reminders, rank rebalance', 'evb', true],
  ['simple_email_service', AWS.sec, 'Amazon SES', 'transactional e-mail', 'ses', false],
  ['key_management_service', AWS.sec, 'KMS', 'keys: S3, Aurora, secrets', 'kms', false],
  ['secrets_manager', AWS.sec, 'Secrets Manager', 'database credentials', 'sm', false],
  ['parameter_store', AWS.mgmt, 'SSM Parameter Store', 'non-secret config', 'ssm', true],
]
svc.forEach(([name, color, l1, l2, id, shape], i) => p1.aws(reg, name, color, 60 + (i % 2) * 280, 70 + Math.floor(i / 2) * 190, br(l1, l2), { id, shape }))
p1.text(reg, 330, 640, 250, 120, br('<b>VPC endpoints</b>', 'S3 (gateway); Secrets Manager, SSM, SQS, SES, CloudWatch Logs, STS (interface). Calls to AWS services stay off the internet.'), { size: 10, fill: '#FFFFFF', stroke: '#879196', id: 'vpce' })

// Operations and security band
const ops = p1.panel(cloud, 310, 1090, 1700, 170, 'Operations and security', { stroke: '#E7157B', size: 12, font: '#E7157B', id: 'ops' })
const opsIcons = [
  ['cloudwatch_2', AWS.mgmt, 'CloudWatch', 'logs · metrics · alarms', 'cw'], ['sns', AWS.integ, 'SNS', 'alarms to on-call', 'sns'],
  ['xray', AWS.mgmt, 'X-Ray', 'traces via ADOT', 'xray'], ['cloudtrail', AWS.mgmt, 'CloudTrail', 'API audit trail', 'ct'],
  ['config', AWS.mgmt, 'AWS Config', 'drift and compliance', 'cfg'], ['security_hub', AWS.sec, 'Security Hub', 'findings in one place', 'sh'],
  ['guardduty', AWS.sec, 'GuardDuty', 'threat detection, S3 malware scan', 'gd'], ['single_sign_on', AWS.sec, 'IAM Identity Center', 'staff and operator access', 'iic'],
]
opsIcons.forEach(([n, c, l1, l2, id], i) => p1.aws(ops, n, c, 70 + i * 205, 40, br(l1, l2), { id }))

// Build and deploy band
const ci = p1.panel(cloud, 310, 1290, 1700, 170, 'Build and deploy', { stroke: '#C925D1', size: 12, font: '#C925D1', id: 'ci' })
p1.text(ci, 40, 40, 190, 80, br('<b>SonarQube</b>', 'code scan · quality gate'), { fill: '#FFFFFF', stroke: '#C925D1', align: 'center', valign: 'middle', size: 10, id: 'sq' })
p1.text(ci, 330, 40, 190, 80, br('<b>Jenkins Core pipeline</b>', 'build · test · deploy'), { fill: '#FFFFFF', stroke: '#C925D1', align: 'center', valign: 'middle', size: 10, id: 'jk' })
p1.text(ci, 620, 40, 190, 80, br('<b>JFrog Artifactory</b>', 'container images'), { fill: '#FFFFFF', stroke: '#C925D1', align: 'center', valign: 'middle', size: 10, id: 'af' })
p1.aws(ci, 'cloudformation', AWS.mgmt, 880, 40, br('CloudFormation / CDK', 'all AWS resources as code'), { id: 'cfn' })
p1.text(ci, 1090, 36, 590, 110, br('<b>Release:</b> a source change starts the Jenkins Core pipeline: build and test, a SonarQube scan whose quality gate must pass, then the image is pushed to JFrog Artifactory. The same pipeline deploys it to EKS as a rolling update; the cluster pulls the image from Artifactory.', '<b>Database migrations</b> run as a pre-deploy Kubernetes Job. A failed health check rolls back to the previous image. Jenkins, SonarQube and Artifactory are the company\'s own build tools, not AWS services.'), { size: 10, noOverlap: true })

p1.text('1', 360, 1600, 2060, 50, `<span style="color:#545B64"><b>Indicative sizing (to be confirmed):</b> 3 AZs, a NAT gateway per AZ · API 6 to 60 pods · Aurora db.r7g.2xlarge writer + 2 readers · ElastiCache 2 shards × 2 nodes. Region, instance sizes and quotas are placeholders.</span>`, { size: 11, noOverlap: true })

// ── Flows ──  (absolute page coordinates for waypoints; exit/entry points are fixed so lines run in clear lanes)
const f = (n, src, tgt, label, color, o = {}) => p1.edge({ source: src, target: tgt, value: label ? `${n}  ${label}` : '', st: flow(color, { ...(o.pts ?? {}), ...(o.st ?? {}) }), points: o.points ?? [] })
f(1, 'users', 'cf', 'HTTPS', BLUE, { pts: pt(1, 0.5, 0, 0.5) })
f(1, 'cf', 's3web', 'web app (OAC)', BLUE, { pts: pt(0.5, 1, 0.5, 0) })
p1.edge({ source: 'r53', target: 'cf', value: '', st: flow(GREY, { strokeWidth: 1.2, dashed: 1, dashPattern: '3 3', fontStyle: 0, ...pt(0.5, 1, 0.3, 0) }), points: [[438, 372], [504, 372]] })
f(2, 'cf', 'alb', '/api/v1 · live-update streams', ORANGE, { pts: pt(1, 0.5, 0, 0.5) })
f(2, 'alb', 'eks', 'to pod IPs', ORANGE, { pts: pt(1, 0.5, 0, 0.25) })
f(3, 'eks', 'proxy', 'writes (pooled)', GREEN, { pts: pt(0.15, 1, 0.5, 0), points: [[1099, 788], [774, 788]] })
f(3, 'eks', 'aurora', 'reads (reader endpoint)', GREEN, { pts: pt(0.55, 1, 0.85, 0), points: [[1363, 796], [1268, 796]] })
p1.edge({ source: 'proxy', target: 'aur_writer', st: flow(GREEN, { strokeWidth: 1.5, ...pt(1, 0.5, 0, 0.5) }) })
f(4, 'eks', 'aur_writer', 'LISTEN/NOTIFY (direct)', PURPLE, { pts: pt(0.35, 1, 0.5, 0), st: dash, points: [[1231, 804], [926, 804]] })
f(5, 'users', 's3att', 'presigned PUT/GET: browser to S3 directly', TEAL, { pts: pt(0, 0.5, 0.5, 0), points: [[8, 428], [8, 90], [2098, 90]] })
p1.edge({ source: 'eks', target: 'sqs', value: '6  enqueue ⇄ consume', st: flow(RED, { ...dash, startArrow: 'block', startFill: 1, ...pt(1, 0.12, 0, 0.5) }) })
p1.edge({ source: 'eks', target: 'regional', value: '', st: flow(GREY, { strokeWidth: 1.5, dashed: 1, dashPattern: '2 3', ...pt(1, 0.5, 0, 0.5) }) })
p1.edge({ source: 'eks', target: 'cache', value: 'cache · rate limits', st: flow(GREY, { strokeWidth: 1.5, dashed: 1, dashPattern: '2 3', ...pt(0.9, 1, 0.5, 0) }), points: [[1300, 811], [1160, 811]] })
f(7, 'vpc', 'ops', 'telemetry: pods → ADOT collector → CloudWatch, X-Ray', GREY, { pts: pt(0.5, 1, 0.5, 0) })
p1.edge({ source: 'jk', target: 'sq', value: 'scan', st: flow(GREY, { strokeWidth: 1.5, ...pt(0, 0.5, 1, 0.5) }) })
p1.edge({ source: 'jk', target: 'af', value: 'push image', st: flow(GREY, { strokeWidth: 1.5, ...pt(1, 0.5, 0, 0.5) }) })

// ───────────────────────────── Page 2: disaster recovery and data ─────────────────────────────
const p2 = new Page('2 · Disaster recovery and data', { width: 2400, height: 1300 })
p2.text('1', 20, 14, 2000, 70, `<b style="font-size:26px">${APP} on AWS: disaster recovery (pilot light) and where data lives</b><br><span style="font-size:12px;color:#545B64">A second region keeps the database and files replicated and the compute scaled down. Failover is a runbook step, not automatic. Targets are indicative and need agreeing.</span>`, { noOverlap: true })

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
  p2.text(reg, rx - 36, 340, 150, 70, br('<b>JFrog Artifactory</b>', 'container images', 'pulled by EKS'), { fill: '#FFFFFF', stroke: '#C925D1', align: 'center', valign: 'middle', size: 10, id: `art${tag}` })
  p2.aws(reg, 'secrets_manager', AWS.sec, rx, 480, br('Secrets Manager', warm ? 'replica secrets' : 'secrets'), { id: `sm${tag}` })
  p2.aws(reg, 'application_load_balancer', AWS.net, lx, 60, 'ALB', { shape: true, id: `alb${tag}` })
  p2.aws(reg, 'eks', AWS.compute, lx, 184, br('EKS', warm ? 'control plane up · nodes at zero' : '3 AZs · autoscaled'), { id: `eks${tag}` })
  p2.aws(reg, 'key_management_service', AWS.sec, lx, 308, br('KMS', 'multi-Region keys'), { id: `kms${tag}` })
  p2.aws(reg, 'sqs', AWS.integ, lx, 432, br('SQS', warm ? 'empty queue' : 'job queue'), { id: `sqs${tag}` })
  p2.aws(reg, 'elasticache', AWS.db, lx, 556, br('ElastiCache', warm ? 'cold start' : 'cache'), { id: `cache${tag}` })
}
p2.text(regB, 20, 700, 600, 70, br('<b>On failover (runbook):</b> promote the Aurora secondary · scale Karpenter node pools up · point Route 53 and CloudFront at region B · re-enable the SQS workers. Rehearse twice a year.'), { size: 10, noOverlap: true })
p2.text(regA, 20, 700, 600, 70, br('<b>Normal operation:</b> all traffic is served here. Aurora Global Database copies storage to region B (typically under a second). S3 replication copies the files.'), { size: 10, noOverlap: true })
const g = (src, tgt, label, color, o = {}) => p2.edge({ source: src, target: tgt, value: label, st: flow(color, o.st ?? {}), points: o.points ?? [] })
g('r53b', 'cfb', '', GREY, { st: { strokeWidth: 1.5, ...pt(0.5, 1, 0.5, 0) } })
g('cfb', 'albA', 'primary origin', BLUE, { st: pt(0, 0.5, 0.5, 0), points: [[138, 318]] })
g('cfb', 'albB', 'failover origin', ORANGE, { st: { ...dash, ...pt(1, 0.5, 0.5, 0) }, points: [[1398, 318]] })
const repl = (a, b, label, color) => g(a, b, label, color, { st: { strokeWidth: 2.5, ...pt(1, 0.5, 0, 0.5) } })
repl('aurA', 'aurB', 'Aurora Global DB', GREEN)
repl('s3A', 's3B', 'S3 replication', TEAL)
repl('smA', 'smB', 'secret replication', GREY)

// Right column: recovery targets and where data lives
const rt = p2.panel('1', 1620, 100, 760, 300, 'Recovery targets (indicative, to be agreed)', { stroke: '#879196', size: 13 })
const rows = [['Scenario', 'RPO', 'RTO'], ['Pod or node failure', '0', 'seconds (rescheduled)'], ['Availability Zone outage', '0 (Multi-AZ Aurora)', 'about 1 to 2 minutes (failover)'], ['Region outage', 'about 1 minute (Global DB lag)', '30 to 60 minutes (runbook)'], ['Bad deploy', '0', 'minutes (rollback to previous image)'], ['Data corruption / mistake', 'point in time, to the second', 'hours (restore to a new cluster)']]
rows.forEach((r, i) => r.forEach((cell, j) => p2.text(rt, 14 + [0, 270, 500][j], 44 + i * 40, [256, 226, 246][j], 38, i === 0 ? `<b>${cell}</b>` : cell, { size: 10, noOverlap: true })))
const dl = p2.panel('1', 1620, 430, 760, 390, 'Where data lives and what each AWS service is for', { stroke: '#879196', size: 13 })
const lives = [
  ['Aurora PostgreSQL', 'system of record: projects, issues, comments, users, history. Automated backups and point-in-time recovery; replicated to region B.'],
  ['RDS Proxy', 'pools database connections from the API pods and speeds up failover.'],
  ['S3', 'attachment files and the web app build. Versioned, encrypted with KMS, replicated to region B.'],
  ['ElastiCache', 'ephemeral: rate-limit counters, cached project configuration. Safe to lose.'],
  ['SQS', 'in-flight background jobs only. Jobs are retried; the database is the source of truth.'],
  ['Secrets Manager and KMS', 'database credentials and encryption keys. Replicated; rotated on a schedule.'],
]
lives.forEach(([h, t], i) => p2.text(dl, 14, 44 + i * 56, 732, 54, `<b>${h}.</b> ${t}`, { size: 10, noOverlap: true }))
p2.text('1', 1620, 850, 760, 80, br('<b>Notes.</b> Region, instance sizes and recovery targets are placeholders to confirm. Region B runs only the data replicas until a failover is declared. Container images come from JFrog Artifactory; how it is made available to region B is to be agreed with its owners.'), { size: 10, color: '#545B64', noOverlap: true })

// ───────────────────────────── Checks and output ─────────────────────────────
const pages = [p1, p2]
const out = new URL('../../docs/architecture/jira-build-aws-architecture.drawio', import.meta.url)
let bad = 0
for (const p of pages) { const pr = p.problems(); if (pr.length) { bad += pr.length; console.error(`[${p.name}]\n` + pr.join('\n')) } }
if (bad) process.exit(1)
writeFileSync(out, drawioFile(pages, { name: `${APP} AWS architecture` }))
console.log(`wrote jira-build-aws-architecture.drawio: ${pages.length} page(s), ${pages.reduce((n, p) => n + p.cells.size + p.edges.length, 0)} cells`)

"""Render the saved benchmark as a readable, standalone HTML document. No model calls."""
import html
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'data/demo/benchmarks/full'
load = lambda name: json.loads((ROOT / name).read_text())
esc = lambda x: html.escape(str(x), quote=True)

def table(headers, body, cls=''):
    return f'<table class="{cls}"><thead><tr>'+''.join(f'<th>{esc(h)}</th>' for h in headers)+'</tr></thead><tbody>'+body+'</tbody></table>'

css = r'''
:root{--ink:#18233b;--muted:#64748b;--line:#e2e8f0;--blue:#2459d6;--surface:#fff;--bg:#f4f6fa;--amber:#925b0c}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}button,input,select{font:inherit}button{cursor:pointer}main{max-width:1400px;margin:auto;padding:32px 40px 64px}.topline{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted);letter-spacing:.03em}.brand{font-weight:750;color:var(--ink)}h1{font-size:34px;line-height:1.15;letter-spacing:-.035em;margin:22px 0 10px}h2{font-size:22px;letter-spacing:-.025em;margin:0 0 8px}h3{font-size:18px;margin:8px 0}p{margin:8px 0 14px}.lead{font-size:15px;color:var(--muted);max-width:900px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:24px 0}.stat{border:1px solid var(--line);border-radius:12px;padding:18px 20px;background:#fff}.stat strong{font-size:30px;letter-spacing:-.04em;display:block}.stat span{font-weight:650}.stat small{display:block;color:var(--muted);margin-top:4px}.tabs{display:flex;gap:6px;border-bottom:1px solid #cdd5e1;margin:28px 0 22px;overflow:auto}.tabs button{border:0;background:none;color:var(--muted);font-weight:650;padding:12px 18px;white-space:nowrap;border-bottom:3px solid transparent}.tabs button[aria-selected=true]{color:var(--blue);border-bottom-color:var(--blue)}.panel{display:none}.panel.active{display:block}.section-head{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin:0 0 18px}.section-head p{color:var(--muted);max-width:860px;margin-bottom:0}.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:18px 0}.toolbar input{flex:1;min-width:220px}.toolbar input,.toolbar select{border:1px solid #cad3df;border-radius:8px;padding:10px 12px;background:white;color:var(--ink)}.results-count{color:var(--muted);font-size:12px;white-space:nowrap}.table-viewport{overflow:auto;max-height:68vh;background:#fff;border:1px solid var(--line);border-radius:12px}table{border-collapse:collapse;width:100%;font-size:13px}th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.045em;color:#5f6d83;background:#f8fafc;font-weight:700;padding:13px 16px;border-bottom:1px solid var(--line);white-space:nowrap}td{padding:14px 16px;border-bottom:1px solid #edf0f5;vertical-align:middle}tbody tr:last-child td{border-bottom:0}.table-viewport>table>thead th{position:sticky;top:0;z-index:2}.numeric{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.numeric .number{font-size:15px}.numeric small{display:block}.count,small{font-size:11px;color:var(--muted)}td>b,td>small{display:block}.skill-row:hover{background:#f8faff}.skill-toggle{display:flex;align-items:center;gap:12px;text-align:left;border:0;background:none;padding:0;color:var(--ink);width:100%;min-width:240px}.skill-toggle b{font-size:13px;font-weight:650}.skill-toggle small{display:block;margin-top:3px}.chevron{font-size:22px;color:#7f8da1;line-height:1;display:inline-block;transition:transform .15s}.skill-toggle[aria-expanded=true] .chevron{transform:rotate(90deg)}.badge{display:inline-block;border-radius:5px;font-size:10px;font-weight:700;letter-spacing:.02em;padding:4px 7px;white-space:nowrap;background:#eef2f7;color:#52637a}.badge.warning{background:#fff3dc;color:#925b0c}.badge.danger{background:#ffebe8;color:#a8382c}.badge.quiet{background:#edf4ff;color:#315a96}.absent{color:#94a3b8;font-size:12px}.detail-row>td{padding:0;background:#f1f5fc}.skill-detail{padding:24px 28px}.eyebrow{font:11px ui-monospace,SFMono-Regular,monospace;letter-spacing:.02em;color:#60728d;display:block;white-space:nowrap;overflow:auto}.criteria{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:18px 0}.criteria>div{background:#fff;border:1px solid #dce5f1;border-radius:8px;padding:12px 14px}.criteria b{font-size:11px;color:var(--blue)}.criteria p{font-size:12px;line-height:1.55;margin:5px 0 0;color:#52617a}.comparison{background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden}.comparison td:first-child{width:62%}.comparison th:not(:first-child),.comparison td:not(:first-child){text-align:center;white-space:nowrap}.comparison small{display:block}.level{display:inline-block;min-width:32px;border-radius:6px;padding:4px 7px;font-weight:700;font-size:12px;background:#eef2f7}.level.codex{background:#edf2ff;color:#365cab}.level.claude{background:#f4edff;color:#8152ad}.level.muse{background:#e7f4ef;color:#277055}.mini-detail{font-size:12px;margin-top:8px}.mini-detail>summary{color:var(--blue);cursor:pointer}.notes{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:12px 0}.notes b{font-size:11px}.notes p{margin:4px 0;font-size:12px;color:#586780}.sources{padding:0;list-style:none;margin:12px 0 18px;font-size:12px}.sources li{display:flex;gap:14px;margin:7px 0;align-items:baseline}.sources a{overflow-wrap:anywhere}.sources span{color:var(--muted);font-size:11px;white-space:nowrap}.text-button{color:var(--blue);border:0;background:none;padding:0;text-align:left;font-size:12px}.text-button:hover{text-decoration:underline}.callout{border:1px solid #e7d7ae;background:#fff9ed;border-radius:10px;padding:16px 18px;color:#6d5224;font-size:13px;margin:18px 0}.callout.blue{background:#eef4ff;border-color:#cfdef8;color:#34547f}.two-col{display:grid;grid-template-columns:1fr 1fr;gap:18px}.box{background:#fff;border:1px solid var(--line);border-radius:12px;padding:22px}.box h3{margin-top:0}.box p{color:var(--muted)}.split-stats{display:flex;gap:30px;margin:20px 0}.split-stats strong{display:block;font-size:26px;letter-spacing:-.03em}.split-stats small{display:block}.chips{display:flex;gap:7px;flex-wrap:wrap;margin:14px 0}.chip{background:#edf1f7;border-radius:5px;padding:5px 8px;color:#53637b;font-size:12px}.repo-card{background:#fff;border:1px solid var(--line);border-radius:10px;margin-bottom:10px}.repo-card>summary{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:17px 20px;cursor:pointer;list-style:none}.repo-card>summary::-webkit-details-marker{display:none}.repo-card b{font-size:14px}.repo-card small{display:block;margin-top:3px}.repo-meta{font-size:12px;color:var(--muted);white-space:nowrap;display:flex;align-items:center;gap:18px}.repo-content{padding:0 20px 20px}.muted{color:var(--muted)}code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px}.missing-table td{vertical-align:top;line-height:1.6}.missing-table td:nth-child(1){width:20%}.missing-table td:nth-child(3){width:31%}.missing-table td:nth-child(4){width:30%}.missing-table .text-button{display:block;margin-top:7px}.missing-table .badge{white-space:normal}.method-list{padding-left:20px}.method-list li{margin-bottom:12px}.legend{color:var(--muted);font-size:12px;margin:12px 0}.audit-list{padding-left:18px;font-size:13px}.audit-list li{margin:10px 0}.footer{font-size:11px;color:#8190a6;margin-top:28px;padding-top:16px;border-top:1px solid var(--line)}.downloads{display:flex;gap:15px;font-size:12px}.zero{font-size:14px;color:var(--muted);text-align:center;padding:30px}.screenreader{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}[hidden]{display:none!important}@media(max-width:850px){main{padding:22px 16px}.stats{grid-template-columns:repeat(2,1fr)}h1{font-size:29px}.criteria,.notes,.two-col{grid-template-columns:1fr}.table-viewport{max-height:none}.section-head{display:block}.skill-detail{padding:20px 16px}.tabs button{padding:11px 13px}.missing-table{min-width:850px}.repo-meta{font-size:11px}.topline{align-items:flex-start}}@media print{body{background:white}main{max-width:none;padding:0}.tabs,.toolbar,.downloads,.text-button{display:none}.panel{display:block!important;margin-top:28px}.table-viewport{max-height:none;overflow:visible;border-radius:0}.stat{break-inside:avoid}.repo-card{break-inside:avoid}.detail-row{display:none!important}th{position:static!important}.stats{grid-template-columns:repeat(4,1fr)}a{color:inherit}.footer{margin-top:15px}}
'''

def render_run(run):
    """Display a run's scores.json, computed by score-benchmark-run.py. No calculations here."""
    run_dir = ROOT / 'runs' / run
    score = json.loads((run_dir / 'scores.json').read_text())
    evaluators = ('codex', 'claude')
    pct = lambda v: f'{v:.2f}%'
    stats = ''
    for e in evaluators:
        o = score['overall'][e]
        for key, label in (('detection_agreement', 'Detection agreement'), ('level_closeness', 'Level closeness')):
            value = pct(o[key]) if o else '—'
            detail = f'{o["packets"]} packets · {o["pairs"]} marker decisions' if o else 'Not reviewed'
            stats += f'<div class="stat"><strong>{value}</strong><span>{label} vs {e.title()}</span><small>{detail}</small></div>'
    compare = ''
    if score['comparison']:
        c = score['comparison']
        cell = lambda o, k: pct(o[k]) if o else '—'
        body = ''.join(f'<tr><td><b>{e.title()}</b></td><td class="numeric">{cell(v["before"], "detection_agreement")}</td><td class="numeric">{cell(v["after"], "detection_agreement")}</td><td class="numeric">{cell(v["before"], "level_closeness")}</td><td class="numeric">{cell(v["after"], "level_closeness")}</td></tr>' for e, v in c['scores'].items())
        compare = f'<h2>Before and after: {esc(c["before"])} → {esc(c["after"])}</h2><div class="table-viewport">{table(["Evaluator", "Detection before", "Detection after", "Closeness before", "Closeness after"], body)}</div>'
    pill = lambda v, kind: f'<span class="level {kind}">L{v}</span>' if v else '<span class="absent">0</span>'
    def judged(row, e):
        r = row.get(e)
        if not r:
            return '<td>—</td><td>—</td><td>—</td>'
        mark = '✓' if r['detection'] else '✗'
        return f'<td>{pill(r["expected"], e)}</td><td class="numeric">{mark}</td><td class="numeric">{100 * r["credit"]:.2f}%</td>'
    def reasons(row):
        notes = ''.join(f'<div><b>{label}</b><p>{esc(text)}</p></div>' for label, text in (
            ('Muse', row['muse_reason'] or 'Not returned (level 0).'),
            ('Codex', (row.get('codex') or {}).get('reason', 'Not reviewed.')),
            ('Claude', (row.get('claude') or {}).get('reason', 'Not reviewed.'))))
        return f'<details class="mini-detail"><summary>Reasons</summary><div class="notes">{notes}</div></details>'
    rows = ''.join(f'<tr class="run-row" data-search="{esc((r["repository"]+" "+r["case"]+" "+r["skill"]).lower())}"><td><b>{esc(r["repository"])}</b><small>{esc(r["case"])}</small></td><td>{esc(r["skill"])}{reasons(r)}</td><td>{pill(r["muse"], "muse")}</td>{judged(r, "codex")}{judged(r, "claude")}</tr>' for r in score['rows'])
    disputes = ''.join(f'<tr><td><b>{esc(d["case"])}</b></td><td>{esc(d["skill"])}</td><td>{pill(d["muse"], "muse")}</td><td>{pill(d["codex"], "codex")}<small>{esc(d["codex_reason"])}</small></td><td>{pill(d["claude"], "claude")}<small>{esc(d["claude_reason"])}</small></td></tr>' for d in score['reviewer_disagreements'])
    page = f'''<main><header><div class="topline"><span class="brand">CLEARHIRE <span class="muted">/ EVALUATION</span></span><span>Run {esc(run)} · Contributor model</span></div><h1>Skill benchmark run {esc(run)}</h1><p class="lead">Muse compared separately with Codex and Claude across all 100 markers in every packet. Omitted markers count as level 0, and shared zeros are included.</p><div class="stats">{stats}</div><div class="callout blue">These are <b>evaluator-agreement scores</b>, not proven accuracy. Both evaluators saw Muse's output, so their levels may anchor on it. Detection agreement: correct when both levels are positive or both are 0. Level closeness: credit = 1 − |Muse − evaluator| ÷ 3.</div></header>{compare}<h2 style="margin-top:28px">Marker comparison</h2><p class="legend">Rows where any level is nonzero. Shared-zero markers are not listed but count in every score.</p><div class="toolbar"><input id="run-search" placeholder="Search repository, packet or marker…" aria-label="Search rows"></div><div class="table-viewport">{table(["Repository", "Skill", "Muse", "Codex expected", "Codex detection", "Codex closeness", "Claude expected", "Claude detection", "Claude closeness"], rows, "comparison")}</div><h2 style="margin-top:28px">Reviewer disagreements <span class="muted">{len(score["reviewer_disagreements"])}</span></h2><p class="legend">Marker–packet pairs where Codex and Claude expect different levels.</p><div class="table-viewport">{table(["Packet", "Marker", "Muse", "Codex", "Claude"], disputes)}</div><footer class="footer">Evaluator agreement on saved evidence, not a hiring-success score.</footer></main>'''
    js = "document.getElementById('run-search').addEventListener('input',e=>document.querySelectorAll('.run-row').forEach(r=>r.hidden=!r.dataset.search.includes(e.target.value.toLowerCase())));"
    out = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ClearHire · Benchmark run</title><style>'+css+'</style></head><body>'+page+'<script>'+js+'</script></body></html>'
    (run_dir / 'REPORT.html').write_text(out)
    print(f'Rendered {run_dir / "REPORT.html"}')

if '--run' in sys.argv:
    render_run(sys.argv[sys.argv.index('--run') + 1])
    raise SystemExit
cat = load('catalogue-snapshot.json')
score = load('scores.json')
cases = load('benchmark.json')['cases']
muse = {r['case']: r for r in load('muse-results.json')['results']}
claude = {c['id']: c for p in sorted(ROOT.glob('claude-review-*.json')) for c in json.loads(p.read_text())['cases']}
skills = {s['id']: s for s in cat['skills']}
categories = {c['id']: c['name'] for c in cat['categories']}
metrics = {m['skill']: m for m in score['metrics']}
C = {c['id']: {s['skill_id']: s for s in c['expected_skills']} for c in cases}
H = {k: {s['skill_id']: s for s in v['skills']} for k, v in claude.items()}
M = {k: {s['skill_id']: s for s in v['output']['skills']} for k, v in muse.items()}
name = lambda skill: skills[skill]['name']
level = lambda record: record.get('level', 0) if record else 0

def pill(value, kind='neutral'):
    return f'<span class="level {kind}">L{value}</span>' if value else '<span class="absent" title="Not returned / not demonstrated">—</span>'

def percentage(value):
    if value.startswith('N/A'):
        return '<span class="absent">Not scored</span>'
    match = re.fullmatch(r'([\d.]+)% \((\d+)/(\d+)\)', value)
    if not match:
        return esc(value)
    p, a, b = match.groups()
    return f'<strong class="number">{p}%</strong><small class="count">{a} / {b}</small>'

def source_links(case):
    return '<ul class="sources">'+''.join(f'<li><a href="{esc(f["source_url"])}" target="_blank" rel="noreferrer">{esc(f["path"])}</a><span>Lines {f["startLine"]}–{f["endLine"]}</span></li>' for f in case['files'])+'</ul>'

def evidence_rows(skill):
    rows = []
    for c in cases:
        key = c['id']
        a, b, m = C[key].get(skill), H[key].get(skill), M[key].get(skill)
        if not any((a, b, m)):
            continue
        disagree = level(a) != level(b)
        reason = lambda record: esc((record or {}).get('reason', (record or {}).get('rationale', 'Marker not returned. This is an omission, not an explicit rejection.')))
        reasons = f'<details class="mini-detail"><summary>Reviewer notes</summary><div class="notes"><div><b>Codex</b><p>{reason(a)}</p></div><div><b>Claude</b><p>{reason(b)}</p></div><div><b>Muse</b><p>{reason(m)}</p></div></div>{source_links(c)}</details>'
        rows.append(f'<tr><td><a href="https://github.com/{esc(c["repository"])}/tree/{esc(c["commit_sha"])}">{esc(c["repository"])}</a><small>{esc(key)}</small>{reasons}</td><td>{pill(level(a),"codex")}</td><td>{pill(level(b),"claude")}</td><td>{pill(level(m),"muse")}</td><td>{"<span class=badge>Disputed</span>" if disagree else "Agreed"}</td></tr>')
    return table(['Evidence packet', 'Codex', 'Claude', 'Muse', 'Reference'], ''.join(rows), 'comparison')

active = {}
for skill in skills:
    keys = [c['id'] for c in cases if skill in C[c['id']] or skill in H[c['id']]]
    differing = [k for k in keys if level(C[k].get(skill)) != level(H[k].get(skill))]
    presence = sum((skill in C[k]) != (skill in H[k]) for k in differing)
    active[skill] = {'n': len(keys), 'd': len(differing), 'presence': presence, 'levels': len(differing)-presence}
consistent = [s for s, a in active.items() if a['n'] >= 2 and a['d']/a['n'] >= .75]
consistent.sort(key=lambda s: (-active[s]['d']/active[s]['n'], -active[s]['n'], name(s)))
single = [s for s, a in active.items() if a['n'] == 1 and a['d'] == 1]
seen = set().union(*(set(v) for v in M.values()))
missing = [s for s in skills if s not in seen]

missing_notes = {
    'memory-management': ('Mapping omission', 'Both reviewers agree on ExitStack resource unwinding. Muse describes the cleanup behavior but omits this marker.', 'Require independent mapping of resource ownership and cleanup, not only error handling.'),
    'natural-language-processing': ('Mapping omission', 'Both reviewers identify a TF-IDF text-classification pipeline at L2. Muse describes text processing but returns only general ML markers.', 'Allow a text pipeline to demonstrate both NLP and classical ML when each criterion is met.'),
    'native-mobile-development': ('Mapping omission', 'Both reviewers identify the Android Compose/ViewModel screen at L2. Muse returns component and state markers but omits native mobile.', 'Check platform-specific and general capabilities independently.'),
    'secrets-and-key-management': ('Mapping omission', 'Both reviewers identify MultiFernet key rotation at L3. Muse describes rotation but returns cryptography without key management.', 'Map key lifecycle behavior separately from cryptographic integration.'),
    'incident-diagnosis-and-recovery': ('Evidence-policy mismatch', 'Both reviewers accept the CrashLoop runbook at L2. Muse returns documentation only. The rubric explicitly permits runbook evidence.', 'State which markers may use operational documents; do not imply a real incident occurred.'),
    'dependency-and-supply-chain-security': ('Evidence-policy mismatch', 'Both reviewers accept the Dependabot configuration at L1. Muse says configuration alone does not establish the skill.', 'Clarify the L1 evidence policy; add a real dependency-remediation PR as a stronger example.'),
    'network-security': ('Reference boundary', 'Both reviewers label CSRF origin/referer checks L2. Muse maps them to secure input handling. The boundary between these markers is debatable.', 'Adjudicate the taxonomy and add a direct TLS, firewall or rate-limit implementation.'),
    'service-decomposition': ('Level disputed', 'Both reviewers see service decomposition, but disagree between L1 and L2. Muse returns deployment markers without this one.', 'Agree on the level before scoring; distinguish service layout from demonstrated design choices.'),
    'event-driven-application-development': ('Reference disputed', 'Codex labels five event-handler examples; Claude omits the marker in all five. UI callbacks and event-driven system architecture are being conflated.', 'Clarify whether UI events qualify. Add explicit publisher/consumer processing and retry behavior.'),
    'scalability-and-capacity-planning': ('Reference disputed', 'Codex accepts autoscaler configuration at L2; Claude and Muse omit it. Configuration is weaker evidence than capacity work with measurements.', 'Add load-test results and a justified scaling change.'),
    'infrastructure-cost-optimization': ('Reference disputed', 'The packet contains product documentation about consolidation, not evidence of someone implementing or measuring a cost reduction.', 'Use cost-aware provisioning code or a measured before/after configuration change.'),
    'computer-vision': ('Reference disputed', 'Codex labels the MNIST image-classifier example L1. Claude omits it; Muse returns deep learning and preprocessing.', 'Clarify image-task overlap and add explicit image transformations or detection logic.'),
    'application-security-testing': ('Reference disputed', 'Codex accepts escaping tests at L1; Claude and Muse treat them as unit tests and secure input handling.', 'Add explicit exploit payloads, security assertions and an abuse-case test.'),
}

# Compact score table; all long notes and evidence are available on demand.
score_rows = []
for skill in skills:
    s, r = skills[skill], metrics[skill]
    status = 'Not returned' if skill in missing else 'No level consensus' if r['agreed_positive_n'] == 0 else 'Scored'
    badge_class = 'danger' if skill in missing else 'warning' if r['agreed_positive_n'] == 0 else 'quiet'
    filter_text = f'{s["name"]} {skill} {categories[s["categoryId"]]}'.lower()
    score_rows.append(f'<tr class="skill-row" data-search="{esc(filter_text)}" data-category="{esc(s["categoryId"])}" data-missing="{str(skill in missing).lower()}" data-disputed="{str(skill in consistent).lower()}"><td><button class="skill-toggle" aria-expanded="false" aria-controls="detail-{skill}"><span class="chevron">›</span><span><b>{esc(s["name"])}</b><small>{esc(categories[s["categoryId"]])}</small></span></button></td><td class="numeric">{r["agreed_positive_n"]}</td><td class="numeric">{percentage(r["consensus_recall"])}</td><td class="numeric">{percentage(r["consensus_exact_level"])}</td><td class="numeric">{percentage(r["codex_exact_level"])}</td><td class="numeric">{percentage(r["claude_exact_level"])}</td><td><span class="badge {badge_class}">{status}</span></td></tr>')
    criteria = ''.join(f'<div><b>Level {n}</b><p>{esc(s["levels"][str(n)])}</p></div>' for n in range(1,4))
    score_rows.append(f'<tr class="detail-row" id="detail-{skill}" hidden><td colspan="7"><div class="skill-detail"><span class="eyebrow">{esc(skill)}</span><h3>{esc(s["name"])}</h3><p>{esc(s["definition"])}</p><div class="criteria">{criteria}</div>{evidence_rows(skill)}</div></td></tr>')

review_rows = []
for skill in consistent:
    a = active[skill]
    review_rows.append(f'<tr data-search="{esc((name(skill)+" "+skill).lower())}"><td><b>{esc(name(skill))}</b><small>{esc(categories[skills[skill]["categoryId"]])}</small></td><td class="numeric"><strong>{100*a["d"]/a["n"]:.1f}%</strong><small>{a["d"]} / {a["n"]} active packets</small></td><td class="numeric">{a["presence"]}</td><td class="numeric">{a["levels"]}</td><td><button class="text-button" data-open-skill="{skill}">Compare evidence →</button></td></tr>')

missing_rows = []
for skill in missing:
    kind, observed, next_check = missing_notes[skill]
    missing_rows.append(f'<tr><td><b>{esc(name(skill))}</b><button class="text-button" data-open-skill="{skill}">View evidence →</button></td><td><span class="badge warning">{esc(kind)}</span></td><td>{esc(observed)}</td><td>{esc(next_check)}</td></tr>')

repo_cards = []
for c in cases:
    key = c['id']
    union = [s for s in skills if s in C[key] or s in H[key] or s in M[key]]
    rows = ''.join(f'<tr><td><button class="text-button" data-open-skill="{s}">{esc(name(s))}</button></td><td>{pill(level(C[key].get(s)),"codex")}</td><td>{pill(level(H[key].get(s)),"claude")}</td><td>{pill(level(M[key].get(s)),"muse")}</td></tr>' for s in union)
    repo_cards.append(f'<details class="repo-card" data-search="{esc((c["repository"]+" "+key+" "+" ".join(union)).lower())}"><summary><span><b>{esc(c["repository"])}</b><small>{esc(key)}</small></span><span class="repo-meta">{len(c["files"])} excerpts · {len(M[key])} Muse markers<span class="chevron">⌄</span></span></summary><div class="repo-content"><p class="muted">Pinned commit <a href="https://github.com/{esc(c["repository"])}/tree/{esc(c["commit_sha"])}"><code>{esc(c["commit_sha"][:12])}</code></a>. This packet is not the entire repository.</p>{source_links(c)}{table(["Marker", "Codex", "Claude", "Muse"],rows,"comparison")}</div></details>')

agreed_pairs = [(c['id'], skill) for c in cases for skill in skills if level(C[c['id']].get(skill)) > 0 and level(C[c['id']].get(skill)) == level(H[c['id']].get(skill))]
agreed_detected = sum(skill in M[key] for key,skill in agreed_pairs)
agreed_exact = sum(level(M[key].get(skill)) == level(C[key].get(skill)) for key,skill in agreed_pairs)
agreed_markers = len({skill for _,skill in agreed_pairs})
recall_value = 100 * agreed_detected / len(agreed_pairs)
exact_value = 100 * agreed_exact / len(agreed_pairs)
reported_cost = sum(r['costMicroUsd'] for r in muse.values()) / 1e6

def aggregate(reference):
    pairs = [(key,skill) for key,labels in reference.items() for skill in labels]
    found = sum(skill in M[key] for key,skill in pairs)
    exact = sum(level(M[key].get(skill)) == level(reference[key].get(skill)) for key,skill in pairs)
    return len(pairs), f'{100*found/len(pairs):.1f}% · {found} / {len(pairs)}', f'{100*exact/len(pairs):.1f}% · {exact} / {len(pairs)}'
cn,cd,ce = aggregate(C)
hn,hd,he = aggregate(H)
category_options = ''.join(f'<option value="{esc(k)}">{esc(v)}</option>' for k,v in categories.items())
summary_table = table(['Reference labels', 'Identification recall', 'Exact-level agreement'], ''.join(f'<tr><td><b>{label}</b><small>{detail}</small></td><td>{detect}</td><td>{exact}</td></tr>' for label,detail,detect,exact in [
    ('Codex', f'{cn} positive marker–packet labels', cd, ce),
    ('Claude', f'{hn} positive marker–packet labels', hd, he),
    ('Agreed labels', f'{len(agreed_pairs)} positive labels across {agreed_markers} markers', f'{recall_value:.1f}% · {agreed_detected} / {len(agreed_pairs)}', f'{exact_value:.1f}% · {agreed_exact} / {len(agreed_pairs)}'),
]))
body = f'''
<main><header><div class="topline"><span class="brand">CLEARHIRE <span class="muted">/ EVALUATION</span></span><span>November 2, 2026 · Contributor model</span></div><h1>Skill benchmark</h1><p class="lead">100 markers. 62 pinned evidence packets. 51 GitHub repositories. Compare Muse’s output with independent Codex and Claude labels.</p><div class="stats"><div class="stat"><strong>{recall_value:.1f}%</strong><span>Marker identification</span><small>{agreed_detected} / {len(agreed_pairs)} agreed positive labels</small></div><div class="stat"><strong>{exact_value:.1f}%</strong><span>Exact-level agreement</span><small>{agreed_exact} / {len(agreed_pairs)} agreed positive labels</small></div><div class="stat"><strong>25</strong><span>Repeated reviewer disputes</span><small>≥2 active packets · ≥75% disagreement</small></div><div class="stat"><strong>13</strong><span>Markers never returned</span><small>In this suite, not a universal limitation</small></div></div><div class="callout blue">These are comparisons with AI-reviewed reference labels, not human-established ground truth. Only <b>{agreed_markers} of {len(skills)} markers</b> have an agreed positive level. Open a marker to inspect its rubric, evidence and reviewer notes.</div></header>
<nav class="tabs" role="tablist" aria-label="Report sections"><button role="tab" data-tab="scores" aria-selected="true">Skill scores</button><button role="tab" data-tab="disagreements" aria-selected="false">Reviewer disputes <span class="muted">25</span></button><button role="tab" data-tab="missing" aria-selected="false">Missing markers <span class="muted">13</span></button><button role="tab" data-tab="repositories" aria-selected="false">Repositories</button><button role="tab" data-tab="method" aria-selected="false">Method & improvements</button></nav>
<section class="panel active" id="scores"><div class="section-head"><div><h2>Results by marker</h2><p>Identify = Muse returned the marker. Exact level = Muse returned the agreed value. Percentages show their sample counts; “not scored” means no agreed positive example.</p></div><div class="downloads"><a href="scores.csv">Download CSV</a><a href="REPORT.md">Raw Markdown</a></div></div><div class="toolbar"><label class="screenreader" for="skill-search">Search markers</label><input id="skill-search" placeholder="Search a marker or category…"><select id="category-filter" aria-label="Filter category"><option value="">All categories</option>{category_options}</select><select id="status-filter" aria-label="Filter status"><option value="">All markers</option><option value="missing">Never returned</option><option value="disputed">Repeated reviewer disputes</option></select><span class="results-count" id="skill-count">100 markers</span></div><div class="table-viewport">{table(['Marker', 'Agreed tests', 'Identify', 'Exact level', 'vs Codex', 'vs Claude', 'Status'], ''.join(score_rows), 'scores-table')}</div><p class="legend">Expand a row for the actual level comparisons and source links. “—” means not returned / not demonstrated in that packet; it does not mean the person or full repository lacks the skill.</p></section>
<section class="panel" id="disagreements"><div class="section-head"><div><h2>Where reviewers consistently disagree</h2><p>Active packets are those where either reviewer assigned a positive level. Counting shared zeros would hide disagreements. Repeated = at least two active packets and at least 75% exact disagreement.</p></div></div><div class="two-col"><div class="box"><div class="split-stats"><div><strong>201</strong><small>Positive vs omitted · 82.4%</small></div><div><strong>43</strong><small>Different nonzero levels · 17.6%</small></div></div><p>Most disagreement is about whether to list a marker at all. An omitted Claude label is not an explicit rejection with a reason. Codex also labels incidental capabilities more aggressively.</p></div><div class="box"><h3>Reference labels need correction too</h3><ul class="audit-list"><li>Prometheus’s Dockerfile uses <code>:latest</code>; Claude’s “pinned base” explanation is incorrect.</li><li>A pinned build stage does not establish a pinned final image in the microservices example.</li><li>Dynamic imports alone do not establish the measured improvement required by the frontend-performance L2 criterion.</li></ul></div></div><div class="toolbar"><input id="dispute-search" placeholder="Find a disputed marker…" aria-label="Search disputed markers"><span class="results-count">25 recurring disputes</span></div><div class="table-viewport">{table(['Marker', 'Disagreement rate', 'Present vs omitted', 'Level difference', ''], ''.join(review_rows))}</div><details class="box" style="margin-top:20px"><summary><b>20 additional single-example disagreements</b></summary><p>These have only one active packet, so there is not enough evidence to call the disagreement consistent.</p><div class="chips">{''.join(f'<span class="chip">{esc(name(s))}</span>' for s in single)}</div></details></section>
<section class="panel" id="missing"><div class="section-head"><div><h2>Why 13 markers were not returned</h2><p>No schema exclusion, skill-count cap or truncated response explains these omissions. Every ID was available, and outputs were below the 32,000-token cap. The exact internal cause is unknown; the observations below distinguish likely mapping misses from reference-policy problems.</p></div></div><div class="callout">Four strong examples: Muse describes <b>TF-IDF text classification</b>, <b>Android Compose screens</b>, <b>ExitStack cleanup</b> and <b>MultiFernet rotation</b>, but omits NLP, native mobile, memory management and key-management markers. Recognized functionality is not always mapped to every applicable marker.</div><div class="table-viewport" style="max-height:none">{table(['Marker', 'Diagnosis', 'What the saved evidence shows', 'What to test next'], ''.join(missing_rows), 'missing-table')}</div></section>
<section class="panel" id="repositories"><div class="section-head"><div><h2>Repository evidence and outputs</h2><p>Open a packet to compare the nonzero expected and actual levels in aligned rows. Source links are pinned. The packet tests the supplied excerpt, not every capability of the entire repository.</p></div></div><div class="toolbar"><input id="repo-search" placeholder="Search repository, packet or marker ID…" aria-label="Search repository packets"><span class="results-count" id="repo-count">62 packets · 51 repositories</span></div><p class="legend">Blue = Codex · Purple = Claude · Green = Muse. A dash means no positive marker was returned. Reference values have not been changed after observing Muse.</p>{''.join(repo_cards)}</section>
<section class="panel" id="method"><div class="section-head"><div><h2>Read the scores correctly</h2><p>Expected labels were recorded before Muse ran. Claude reviewed the code and catalogue without seeing Codex labels or Muse output. Code attribution is stipulated for this benchmark; no real candidate is graded.</p></div></div><div class="box">{summary_table}<p class="legend">Macro exact-level agreement (each tested marker has equal weight): Codex 56.3% across 100 markers; Claude 53.2% across 93; agreed references 69.8% across 70. The 244 disputed labels are excluded from consensus scores and retained in the separate reviewer scores.</p></div><div class="two-col" style="margin-top:18px"><div class="box"><h3>Improve the references first</h3><ol class="method-list"><li>Require an explicit 0–3 decision for each marker from both reviewers, then compress to positive labels. Sparse output hides overlooked markers.</li><li>Clarify overlapping markers and which level requirements are mandatory versus examples.</li><li>Adjudicate factual label defects. Use stronger implementation evidence for cost, scaling, security and operations.</li></ol></div><div class="box"><h3>Then test the prompt</h3><ol class="method-list"><li>Evaluate every marker independently; return all supported general and specialist markers, not only the most salient ones.</li><li>Explicitly allow config, tests or runbooks only where that marker’s criteria permit them.</li><li>Compare the current prompt with the revised prompt on a development split, then validate on unseen evidence. Test low versus medium reasoning separately.</li></ol></div></div><div class="callout blue">A successful prompt change is a measured improvement on held-out examples, not a promise. This suite does not cover every skill at every level, and well-known code may be familiar to the models. Human review is still needed before these scores become a reference standard.</div><div class="box"><h3>Definitions</h3><p><b>Identification recall:</b> returned positive markers ÷ expected positive markers.</p><p><b>Exact level:</b> exact value matches ÷ expected positive markers.</p><p><b>Precision:</b> correct positive claims ÷ Muse positive claims, using only packets where reviewers agree.</p><p><b>Consistent disagreement:</b> ≥75% exact disagreement across ≥2 packets where at least one reviewer is positive.</p><p class="muted">Muse reported cost: ${reported_cost:.6f}. All 211 repository tests passed. This restyling and diagnosis make no additional model calls.</p></div></section>
<footer class="footer">ClearHire catalogue v2 · muse-spark-1.3-contributor · Saved evidence and reference-label agreement, not a hiring-success score.</footer></main>
'''
js = r'''
function tab(id,hash=true){if(!document.getElementById(id)?.classList.contains('panel'))id='scores';document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id===id));document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-selected',b.dataset.tab===id));if(hash)history.replaceState(null,'','#'+id)}
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>tab(b.dataset.tab)));
function expand(button,force){let row=document.getElementById(button.getAttribute('aria-controls'));let open=force??button.getAttribute('aria-expanded')!=='true';button.setAttribute('aria-expanded',open);row.hidden=!open;}
document.querySelectorAll('.skill-toggle').forEach(b=>b.addEventListener('click',()=>expand(b)));
function filterSkills(){let q=document.getElementById('skill-search').value.toLowerCase(),category=document.getElementById('category-filter').value,status=document.getElementById('status-filter').value,n=0;document.querySelectorAll('.skill-row').forEach(r=>{let show=r.dataset.search.includes(q)&&(!category||r.dataset.category===category)&&(!status||r.dataset[status]==='true');r.hidden=!show;let b=r.querySelector('.skill-toggle');document.getElementById(b.getAttribute('aria-controls')).hidden=!show||b.getAttribute('aria-expanded')!=='true';n+=show});document.getElementById('skill-count').textContent=n+' markers'}
['skill-search','category-filter','status-filter'].forEach(id=>document.getElementById(id).addEventListener('input',filterSkills));
document.querySelectorAll('[data-open-skill]').forEach(b=>b.addEventListener('click',()=>{tab('scores');document.getElementById('skill-search').value='';document.getElementById('category-filter').value='';document.getElementById('status-filter').value='';filterSkills();let toggle=document.querySelector('[aria-controls="detail-'+b.dataset.openSkill+'"]');expand(toggle,true);toggle.scrollIntoView({behavior:'smooth',block:'center'})}));
document.getElementById('dispute-search').addEventListener('input',e=>document.querySelectorAll('#disagreements tbody tr').forEach(r=>r.hidden=!r.dataset.search?.includes(e.target.value.toLowerCase())));
document.getElementById('repo-search').addEventListener('input',e=>{let n=0;document.querySelectorAll('.repo-card').forEach(r=>{r.hidden=!r.dataset.search.includes(e.target.value.toLowerCase());n+=!r.hidden});document.getElementById('repo-count').textContent=n+' packets'});
window.addEventListener('hashchange',()=>tab(location.hash.slice(1),false));tab(location.hash.slice(1)||'scores',false);
'''
output = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ClearHire · Skill benchmark</title><style>'+css+'</style></head><body>'+body+'<script>'+js+'</script></body></html>'
(ROOT / 'REPORT.html').write_text(output)
assert len(consistent) == 25 and len(single) == 20 and len(missing) == 13
print('Rendered readable HTML: 100 expandable markers, 25 recurring disputes, 13 missing markers, 62 repository packets.')

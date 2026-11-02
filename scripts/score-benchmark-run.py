"""Score one Muse benchmark run against each independent evaluator. No model calls.

python3 scripts/render-skill-benchmark.py --run r2 [--compare r1]

Muse is compared separately with Claude and with Codex across all 100 markers per packet. An
omitted marker is level 0 and shared zeros count. Full precision is kept; display rounds.
  Detection agreement: correct when both levels are positive or both are 0.
  Level closeness:     credit = 1 - |Muse - evaluator| / 3.
These are evaluator-agreement scores, not proven accuracy.
Muse results and any evaluator's reviews must cover every benchmark packet exactly once; a
before/after comparison also requires both evaluators on both runs.
"""
import argparse
import json
import runpy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'data/demo/benchmarks/full'
EVALUATORS = ('claude', 'codex')


def detection(muse, expected):
    return (muse > 0) == (expected > 0)


def closeness(muse, expected):
    return 1 - abs(muse - expected) / 3


def packet_scores(muse_levels, expected_levels):
    """Both arguments are full-length level lists for one packet, one entry per marker."""
    n = len(expected_levels)
    pairs = list(zip(muse_levels, expected_levels))
    return (100 * sum(detection(m, e) for m, e in pairs) / n,
            100 * sum(closeness(m, e) for m, e in pairs) / n)


def check_formulas():
    assert packet_scores([2, 1], [3, 0]) == (50.0, 100 * 2 / 3)
    detect, close = packet_scores([2, 1] + [0] * 98, [3, 0] + [0] * 98)
    assert round(detect, 2) == 99.0 and round(close, 2) == 99.33


def by_packet(items, source, expected):
    """Map packet id -> item. Rejects duplicate, missing or unknown packet ids."""
    found = {}
    for packet_id, item in items:
        if packet_id in found:
            raise ValueError(f'{source}: duplicate packet {packet_id}')
        found[packet_id] = item
    missing, unknown = sorted(set(expected) - set(found)), sorted(set(found) - set(expected))
    if missing or unknown:
        raise ValueError(f'{source}: {len(missing)} missing packets {missing[:5]}, unknown {unknown[:5]}')
    return found


def check_packets():
    assert by_packet([('a', 1), ('b', 2)], 't', ['a', 'b']) == {'a': 1, 'b': 2}
    for items in ([('a', 1)], [('a', 1), ('a', 1), ('b', 2)], [('a', 1), ('b', 2), ('c', 3)]):
        try:
            by_packet(items, 't', ['a', 'b'])
        except ValueError:
            continue
        raise AssertionError(f'accepted {items}')


def main():
    check_formulas()
    check_packets()
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', required=True)
    parser.add_argument('--compare')
    args, _ = parser.parse_known_args()
    run_dir = ROOT / 'runs' / args.run
    cases = json.loads((ROOT / 'benchmark.json').read_text())['cases']
    skills = [s['id'] for s in json.loads((ROOT / 'catalogue-snapshot.json').read_text())['skills']]
    ids = [c['id'] for c in cases]
    muse = by_packet(((r['case'], {s['skill_id']: s for s in r['output']['skills']})
                      for r in json.loads((run_dir / 'muse-results.json').read_text())['results']),
                     f'{args.run} Muse results', ids)
    # An evaluator with no review files is reported as not reviewed; a partial review is an error.
    reviews = {}
    for e in EVALUATORS:
        files = sorted(run_dir.glob(f'{e}-*.json'))
        reviews[e] = by_packet(((c['id'], {m['skill_id']: m for m in c['markers']})
                                for p in files for c in json.loads(p.read_text())['cases']),
                               f'{args.run} {e} reviews', ids) if files else {}
    level = lambda record: record['level'] if record else 0

    overall, per_packet, rows, disputes = {}, [], [], []
    for e in EVALUATORS:
        if not reviews[e]:
            overall[e] = None
            continue
        detect_sum = close_sum = 0.0
        for c in cases:
            for skill in skills:
                m, x = level(muse[c['id']].get(skill)), reviews[e][c['id']][skill]['expected_level']
                detect_sum += detection(m, x)
                close_sum += closeness(m, x)
        pairs = len(cases) * len(skills)
        overall[e] = {'detection_agreement': 100 * detect_sum / pairs,
                      'level_closeness': 100 * close_sum / pairs,
                      'packets': len(cases), 'pairs': pairs}

    for c in cases:
        key = c['id']
        packet = {'case': key, 'repository': c['repository']}
        for e in EVALUATORS:
            if key in reviews[e]:
                d, cl = packet_scores([level(muse[key].get(s)) for s in skills],
                                      [reviews[e][key][s]['expected_level'] for s in skills])
                packet[e] = {'detection_agreement': d, 'level_closeness': cl}
        per_packet.append(packet)
        for skill in skills:
            m = level(muse[key].get(skill))
            row = {'case': key, 'repository': c['repository'], 'skill': skill, 'muse': m,
                   'muse_reason': (muse[key].get(skill) or {}).get('justification')}
            for e in EVALUATORS:
                decision = reviews[e].get(key, {}).get(skill)
                if decision:
                    x = decision['expected_level']
                    row[e] = {'expected': x, 'detection': detection(m, x),
                              'credit': closeness(m, x), 'reason': decision['reason']}
            if any(v for v in (m, *(row[e]['expected'] for e in EVALUATORS if e in row))):
                rows.append(row)
            if all(e in row for e in EVALUATORS) and row['claude']['expected'] != row['codex']['expected']:
                disputes.append({'case': key, 'skill': skill, 'muse': m,
                                 'claude': row['claude']['expected'], 'codex': row['codex']['expected'],
                                 'claude_reason': row['claude']['reason'],
                                 'codex_reason': row['codex']['reason']})

    comparison = None
    if args.compare:
        before = json.loads((ROOT / 'runs' / args.compare / 'scores.json').read_text())
        for name, scores in ((args.compare, before['overall']), (args.run, overall)):
            for e in EVALUATORS:
                if (scores.get(e) or {}).get('packets') != len(cases):
                    raise ValueError(f'Cannot compare: {name} lacks complete {e} reviews '
                                     f'for all {len(cases)} packets')
        comparison = {'before': args.compare, 'after': args.run,
                      'scores': {e: {'before': before['overall'].get(e), 'after': overall[e]}
                                 for e in EVALUATORS}}

    result = {'run': args.run, 'overall': overall, 'comparison': comparison,
              'per_packet': per_packet, 'rows': rows, 'reviewer_disagreements': disputes}
    (run_dir / 'scores.json').write_text(json.dumps(result, indent=2) + '\n')

    fmt = lambda v: f'{v:.2f}%'
    lines = [f'# Muse benchmark run {args.run}: evaluator agreement', '',
             'Scores measure agreement with each AI evaluator, not proven accuracy. Evaluators saw '
             "Muse's output, so their levels may anchor on it.", '',
             '| Evaluator | Packets | Detection agreement | Level closeness |', '| --- | ---: | ---: | ---: |']
    for e in EVALUATORS:
        o = overall[e]
        lines.append(f'| {e.title()} | {o["packets"]} | {fmt(o["detection_agreement"])} | '
                     f'{fmt(o["level_closeness"])} |' if o else f'| {e.title()} | 0 | Not reviewed | Not reviewed |')
    if comparison:
        lines += ['', f'## {comparison["before"]} → {comparison["after"]}', '',
                  '| Evaluator | Detection before | Detection after | Closeness before | Closeness after |',
                  '| --- | ---: | ---: | ---: | ---: |']
        for e, v in comparison['scores'].items():
            b, a = v['before'], v['after']
            cell = lambda o, k: fmt(o[k]) if o else 'Not reviewed'
            lines.append(f'| {e.title()} | {cell(b, "detection_agreement")} | {cell(a, "detection_agreement")} | '
                         f'{cell(b, "level_closeness")} | {cell(a, "level_closeness")} |')
    lines += ['', f'Reviewer disagreements (Claude ≠ Codex): {len(disputes)} marker–packet pairs.', '']
    (run_dir / 'REPORT.md').write_text('\n'.join(lines))
    print(json.dumps({'run': args.run, 'overall': overall, 'disagreements': len(disputes)}))
    # The renderer exits after drawing a run report.
    runpy.run_path(str(Path(__file__).with_name('render-benchmark-html.py')), run_name='__main__')


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        raise SystemExit(f'error: {error}')

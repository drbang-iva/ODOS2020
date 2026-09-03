import subprocess, sys, json, os
# Usage (from repo root): python3 docs/build-log/delete-controls-restraint-2026-09-02/harness/mutate.py
# Applies each mutant to ui/src, runs the guard file, restores the file, and writes mutation-report.json beside this script.
W=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "ui")
W=os.path.abspath(W)
C=W+"/src/components/charting/"
MUT = [
 ("M1a guard 1: restore an alert border/text on Clear (CLEAR_TOKEN_CLASS on one control)", C+"ClearControls.tsx",
  'className={`${QUIET_ACTION_CLASS} ${className ?? ""}`}', 'className={`${QUIET_ACTION_CLASS} border border-[color:var(--odos-alert)] text-[color:var(--odos-alert)] ${className ?? ""}`}'),
 ("M1b guard 1: re-add the chrome clear-all alert override in charting.css", W+"/src/styles/charting.css",
  '/* Tier 3 wears exactly the chrome token Cancel wears (§2.2) — no override. Disabled is the shared rule below. */',
  '.odos-exam-entry-sheet-heading .odos-exam-entry-sheet-clear-all button {\n  border-color: var(--odos-alert);\n  color: var(--odos-alert);\n}\n'),
 ("M2 guard 2: render Removes unconditionally (ignore edit state)", C+"section-editing.tsx",
  'if (!editing || closed) return null;', 'if (closed) return null;'),
 ("M2b guard 4: render Removes on a closed encounter too", C+"section-editing.tsx",
  'if (!editing || closed) return null;', 'if (!editing) return null;'),
 ("M2c guard 4: drop BOTH closed checks (provider reset and Remove's own)", C+"section-editing.tsx",
  'if (!hasRecorded || closed) setEditing(false);\n  }, [hasRecorded, closed]);', 'if (!hasRecorded) setEditing(false);\n  }, [hasRecorded, closed]);\n  void closed;', "M2c-extra"),
 ("M3 guard 3: drop the hasRecorded effect (edit state never ends on empty)", C+"section-editing.tsx",
  'if (!hasRecorded || closed) setEditing(false);', 'if (closed) setEditing(false);'),
 ("M3b guard 4: drop the closed reset only (provider keeps edit state through a sign)", C+"section-editing.tsx",
  'if (!hasRecorded || closed) setEditing(false);', 'if (!hasRecorded) setEditing(false);'),
 ("M4 guard 4: hide Edit when nothing is recorded even on a closed encounter", C+"section-editing.tsx",
  'if (!closed && !hasRecorded) return null;', 'if (!hasRecorded) return null;'),
 ("M5 guard 5: shrink the quiet token to the old py-0.5", C+"ClearControls.tsx",
  'inline-flex min-h-11 min-w-11 items-center', 'inline-flex py-0.5 items-center'),
 ("M6 guard 6: route Clear back through window.confirm (bypass the provider)", C+"ClearControls.tsx",
  '  const confirmDestructive = useConfirmDestructive();\n  const closed = isClosedEncounterStatus(encounterStatus);\n  const [busy, setBusy] = useState(false);\n  const [message, setMessage] = useState<string>();\n  const [probedCount',
  '  const confirmDestructive = fallbackConfirmDestructive;\n  const closed = isClosedEncounterStatus(encounterStatus);\n  const [busy, setBusy] = useState(false);\n  const [message, setMessage] = useState<string>();\n  const [probedCount'),
 ("M7 guard 7: put initial focus on the confirm button instead of Keep", C+"ConfirmDestructive.tsx",
  '<button ref={initialFocusRef} type="button" className="odos-confirm-keep" onClick={keep}>', '<button type="button" className="odos-confirm-keep" onClick={keep}>'),
 ("M8 guard 8: revert tier 3 to the long string", C+"ClearControls.tsx",
  '        Clear chart\n', '        Clear everything charted this visit…\n'),
 ("M8b guard 8: revert tier 2 to 'Clear {label}'", C+"ClearControls.tsx",
  '        Clear\n      </button>', '        Clear {label}\n      </button>'),
 ("M9 guard 9: resolve true when no confirm surface exists", C+"ConfirmDestructive.tsx",
  '    : false;', '    : true;'),
]
def run():
    r = subprocess.run(["node","--import","tsx","--test","--test-timeout=30000","tests/deleteControlsRestraint.test.tsx"], cwd=W, capture_output=True, text=True)
    out = r.stdout + r.stderr
    fails = [l.strip() for l in out.splitlines() if l.startswith("not ok")]
    p = [l for l in out.splitlines() if l.startswith("# pass")]; f=[l for l in out.splitlines() if l.startswith("# fail")]
    return (p[0] if p else "?"), (f[0] if f else "?"), fails
report=[]
for entry in MUT:
    name, path, old, new = entry[:4]
    src = open(path).read()
    if len(entry) == 5:
        # M2c: also drop the Remove's own closed check
        src = src  # applied below on the mutated copy
    if name.startswith("M6"):
        # the mutant also needs the fallback import
        src2 = src.replace('import { useConfirmDestructive } from "./ConfirmDestructive";','import { fallbackConfirmDestructive, useConfirmDestructive } from "./ConfirmDestructive";')
    else:
        src2 = src
    assert old in src2, ("mutant anchor missing", name)
    mutated = src2.replace(old,new,1)
    if len(entry) == 5:
        assert 'if (!editing || closed) return null;' in mutated
        mutated = mutated.replace('if (!editing || closed) return null;', 'if (!editing) return null;')
    open(path,"w").write(mutated)
    try:
        p,f,fails = run()
    finally:
        open(path,"w").write(src)
    verdict = "RED (guard fires)" if fails else "GREEN — UNGUARDED"
    report.append({"mutant":name,"pass":p,"fail":f,"failing":fails,"verdict":verdict})
    print(f"{verdict:18} | {name} | {p} {f}")
    for l in fails: print("      ", l[:150])
# restored green
p,f,fails = run()
print("RESTORED:", p, f, "fails:", fails)
report.append({"mutant":"RESTORED (all mutants reverted)","pass":p,"fail":f,"failing":fails})
json.dump(report, open(os.path.dirname(os.path.abspath(__file__))+"/mutation-report.json","w"), indent=2)

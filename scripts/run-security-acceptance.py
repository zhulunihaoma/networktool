"""Run existing security acceptance scripts and preserve logs/fixtures per step."""
from pathlib import Path
from datetime import datetime
import json
import os
import shutil
import subprocess
import sys
import time

root = Path(__file__).resolve().parent.parent
run = Path(sys.argv[1]).resolve()
run.mkdir(parents=True, exist_ok=True)
steps = [
    "verify-security-runtime.mjs",
    "verify-auto-protect.mjs",
    "verify-file-workflow-ui.mjs",
    "verify-security-policy.mjs",
    "verify-security-center.mjs",
    "verify-security-incidents.mjs",
    "verify-security-hardening.mjs",
    "verify-security-overview-ui.mjs",
    "verify-security-inventory-ui.mjs",
    "verify-codex-trust-ui.mjs",
]
results = []
for script in steps:
    directory = run / Path(script).stem
    directory.mkdir(parents=True, exist_ok=True)
    temporary = directory / "tmp"
    temporary.mkdir(exist_ok=True)
    home = directory / "fake-home"
    home.mkdir(exist_ok=True)
    env = os.environ.copy()
    env.pop("ELECTRON_RUN_AS_NODE", None)
    env.pop("NETWORK_LENS_AUTO_PROTECT", None)
    env.pop("NETWORK_LENS_NO_AUTO_PROTECT", None)
    env["TMPDIR"] = str(temporary)
    env["NETWORK_LENS_TEST_HOME"] = str(home)
    env["NETWORK_LENS_EVIDENCE_DIR"] = str(directory)
    command = ["node", "--import", str(root / "scripts/retain-security-evidence.mjs"), str(root / "scripts" / script)]
    start = time.time()
    print("START " + script, flush=True)
    with (directory / "command.log").open("w") as log:
        try:
            process = subprocess.Popen(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                code = process.wait(timeout=180)
            except subprocess.TimeoutExpired:
                import signal
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=10)
                code = 124
        except OSError as error:
            log.write(str(error))
            code = 125
    result = {"script": script, "command": command, "exitCode": code, "durationSeconds": round(time.time() - start, 2), "status": "PASS" if code == 0 else "FAIL", "evidenceDir": str(directory), "finishedAt": datetime.now().astimezone().isoformat()}
    (directory / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    results.append(result)
    (run / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
    if script == "verify-security-hardening.mjs":
        for source in Path("/tmp").glob("nl-hard-*.png"):
            if source.stat().st_mtime >= start:
                shutil.copy2(source, directory / source.name)
    print(json.dumps(result, ensure_ascii=False), flush=True)
    print((directory / "command.log").read_text()[-2200:], flush=True)
sys.exit(1 if any(result["exitCode"] for result in results) else 0)

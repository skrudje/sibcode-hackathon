"""Audit Cargo.lock via OSV; allow the GLib advisory only with the verified backport."""
import hashlib
import json
from pathlib import Path
import time
import tomllib
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'apps/web/src-tauri/Cargo.toml'
PATCH_SHA = 'a0f5ee8acb8faa089bcdfbc9a57372609fce7654026ccef7d9a224d05a654ccc'
FIXED_ADVISORIES = {'RUSTSEC-2024-0429', 'GHSA-wrw7-89jp-8q8g'}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def verify_backport(packages):
    manifest = tomllib.loads(MANIFEST.read_text())
    require(manifest['patch']['crates-io']['glib']['path'] == 'vendor/glib', 'GLib safety override is missing')
    package = next(p for p in packages if p['name'] == 'glib')
    require(package['version'] == '0.18.5' and 'source' not in package, 'GLib must use the local safety backport')
    source = MANIFEST.parent / 'vendor/glib/src/variant_iter.rs'
    require(hashlib.sha256(source.read_bytes()).hexdigest() == PATCH_SHA, 'GLib backport changed: review the upstream fix')


def query(queries):
    body = json.dumps({'queries': queries}).encode()
    for attempt in range(3):
        try:
            request = urllib.request.Request('https://api.osv.dev/v1/querybatch', data=body,
                headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.load(response)['results']
        except OSError:
            if attempt == 2:
                raise
            time.sleep(1)


def main():
    packages = tomllib.loads((MANIFEST.parent / 'Cargo.lock').read_text())['package']
    verify_backport(packages)
    packages = [p for p in packages if p.get('source', '').startswith('registry+') or p['name'] == 'glib']
    failed = False
    for offset in range(0, len(packages), 180):
        batch = packages[offset:offset + 180]
        pending = [(p, {'package': {'ecosystem': 'crates.io', 'name': p['name']}, 'version': p['version']}) for p in batch]
        while pending:
            results = query([entry for _, entry in pending])
            require(len(results) == len(pending), 'Incomplete OSV response')
            next_page = []
            for (package, entry), result in zip(pending, results):
                require('error' not in result, 'OSV package query failed')
                for advisory in result.get('vulns', []):
                    identifier = advisory['id']
                    if package['name'] == 'glib' and identifier in FIXED_ADVISORIES:
                        continue  # Exact source hash and Cargo override verified above.
                    if package['name'] == 'proc-macro-error' and identifier == 'RUSTSEC-2024-0370':
                        print('Warning: GTK3 proc-macro-error is unmaintained (RUSTSEC-2024-0370)')
                        continue
                    print(f"Vulnerable dependency: {package['name']} {package['version']} {identifier}")
                    failed = True
                if token := result.get('next_page_token'):
                    next_page.append((package, {**entry, 'page_token': token}))
            pending = next_page
    print(f'Checked {len(packages)} Rust packages; GLib safety backport verified')
    return int(failed)


if __name__ == '__main__':
    raise SystemExit(main())

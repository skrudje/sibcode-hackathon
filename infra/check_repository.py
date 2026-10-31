"""Reject private environment files, local artifacts and unresolved merge markers."""

from pathlib import PurePosixPath
import re
import subprocess
import sys


PUBLIC_ENV = {'.env.example', '.env.e2e.example'}
ARTIFACT_DIRS = {
    '.data', '.venv', 'node_modules', 'target', 'dist', '__pycache__',
    '.pytest_cache', '.ruff_cache', 'test-results', 'playwright-report',
}
PRIVATE_SUFFIXES = {'.pem', '.key', '.p12', '.pfx', '.db', '.sqlite', '.sqlite3', '.dump'}
ARCHIVED_PATHS = ('Разработка/', 'Отборочное задание/', 'docs/spec/')
MERGE_MARKER = re.compile(rb'^(?:<<<<<<< |=======$|>>>>>>> )', re.MULTILINE)


def main():
    paths = subprocess.check_output(['git', 'ls-files', '-z']).decode().split('\0')
    failures = []
    for name in filter(None, paths):
        path = PurePosixPath(name)
        if path.name.startswith('.env') and name not in PUBLIC_ENV:
            failures.append((name, 'private environment file'))
        if ARTIFACT_DIRS.intersection(path.parts) or name.startswith(ARCHIVED_PATHS):
            failures.append((name, 'local artifact or archived work material'))
        if path.suffix.lower() in PRIVATE_SUFFIXES or path.name in {'id_rsa', 'id_ed25519'} or '.db-' in path.name:
            failures.append((name, 'key, database or backup file'))
        try:
            data = subprocess.check_output(['git', 'show', ':' + name], stderr=subprocess.DEVNULL)
        except subprocess.CalledProcessError:
            failures.append((name, 'cannot read tracked content'))
            continue
        if b'\0' not in data and MERGE_MARKER.search(data):
            failures.append((name, 'unresolved merge marker'))
    if failures:
        for name, reason in failures:
            print(f'ERROR {name}: {reason}')
        return 1
    print(f'Repository hygiene: OK ({sum(bool(path) for path in paths)} tracked files)')
    return 0


if __name__ == '__main__':
    sys.exit(main())

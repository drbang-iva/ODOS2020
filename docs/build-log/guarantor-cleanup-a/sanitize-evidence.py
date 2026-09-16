from pathlib import Path
import gzip
import re

root = Path(__file__).resolve().parent
changed = []

def sanitize(text):
    cleaned = re.sub(r'/(?:[U]sers|home)/[^/\s]+/GitHub/ODOS2020(?:/\.worktrees/[^/\s\)\"\x27]+)?', '<repo>', text)
    cleaned = re.sub(r'[A-Za-z]:\\+[U]sers\\+[^\\\s]+\\+GitHub\\+ODOS2020(?:\\+\.worktrees\\+[^\\\s\)\"\x27]+)?', '<repo>', cleaned)
    cleaned = re.sub(r'/(?:[U]sers|home)/[^/\s\)\"\x27:]+', '<home>', cleaned)
    return re.sub(r'[A-Za-z]:\\+[U]sers\\+[^\\\s\)\"\x27:]+', '<home>', cleaned)

for path in root.rglob('*'):
    if not path.is_file() or path.suffix in {'.png', '.jpg', '.webm'}:
        continue
    compressed = path.suffix == '.gz'
    data = gzip.decompress(path.read_bytes()) if compressed else path.read_bytes()
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        continue
    cleaned = sanitize(text)
    if cleaned != text:
        encoded = cleaned.encode('utf-8')
        path.write_bytes(gzip.compress(encoded, mtime=0) if compressed else encoded)
        changed.append(str(path.relative_to(root)))
print(f'Sanitized {len(changed)} evidence files; diagnostic content retained.')

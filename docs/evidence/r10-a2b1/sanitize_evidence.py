from pathlib import Path
import re


def sanitize(text):
    text = re.sub(r'/Users/[^/\s]+/GitHub/ODOS2020(?:/\.worktrees/[^/\s:\'"()]+)?', '<repo>', text)
    text = text.replace('/home/runner/work/ODOS2020/ODOS2020', '<repo>')
    text = re.sub(r'/Users/[^/\s]+', '<home>', text)
    return re.sub(r'[ \t]+$', '', text, flags=re.MULTILINE)


if __name__ == '__main__':
    root = Path(__file__).resolve().parent
    for path in root.rglob('*'):
        if path.is_file() and path.suffix in {'.tap', '.txt', '.log', '.md', '.jsonl', '.json', '.patch'}:
            before = path.read_text()
            after = sanitize(before)
            if before != after:
                path.write_text(after)

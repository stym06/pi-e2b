"""Bound ripgrep output in the sandbox before sending it across the network."""
import json
import subprocess
import sys
import tempfile

request = json.loads(sys.argv[1])
args = ['rg', '--color=never', '--hidden', '--glob', '!.git', '--no-require-git']
limit = request['limit']
if request['kind'] == 'find':
    args += ['--files', '--glob', request['pattern'], '--', '.']
else:
    args += ['--line-number', '--with-filename', '--no-heading']
    if request.get('ignoreCase'):
        args += ['--ignore-case']
    if request.get('literal'):
        args += ['--fixed-strings']
    if request.get('glob'):
        args += ['--glob', request['glob']]
    if request.get('context'):
        args += ['--context', str(request['context'])]
    args += ['--', request['pattern'], request['path']]

lines = []
size = 0
limited = False
with tempfile.TemporaryFile() as errors:
    child = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=errors)
    try:
        while True:
            # Bounded readline also handles a file containing a single huge line.
            line = child.stdout.readline(65537)
            if not line:
                break
            if len(lines) >= limit or size + len(line) > 50000:
                limited = True
                child.kill()
                break
            size += len(line)
            lines.append(line.decode('utf-8', errors='replace').rstrip('\n'))
        status = child.wait()
        errors.seek(0)
        error = errors.read(4096).decode('utf-8', errors='replace')
        if status not in (0, 1) and not limited:
            raise RuntimeError(error or 'ripgrep exited with code ' + str(status))
    finally:
        child.stdout.close()
        if child.poll() is None:
            child.kill()
            child.wait()
print(json.dumps({'lines': lines, 'limited': limited}))

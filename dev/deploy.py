#!/usr/bin/env python3
"""knowkin 自動デプロイ

チェック（dev/smoke.mjs）→ BUILD_TAG更新 → GitHubのmainに1コミットでpush → Railwayが自動デプロイ

使い方:
  GITHUB_TOKEN=xxxx python3 dev/deploy.py "コミットメッセージ"
  python3 dev/deploy.py --dry-run          # pushせずに対象ファイルだけ表示
環境変数:
  GITHUB_TOKEN  リポジトリの Contents 読み書き権限を持つトークン（必須）
  GITHUB_REPO   既定 kinyatanaka-code/knowkin
  GITHUB_BRANCH 既定 main
"""
import base64, datetime, json, os, subprocess, sys, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.environ.get('GITHUB_REPO', 'kinyatanaka-code/knowkin')
BRANCH = os.environ.get('GITHUB_BRANCH', 'main')
SKIP_DIRS = {'node_modules', '.git'}
SKIP_FILES = {'.env', '.DS_Store'}

def files():
    out = []
    for d, dirs, fs in os.walk(ROOT):
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
        for f in fs:
            if f in SKIP_FILES or f.endswith('.zip'):
                continue
            out.append(os.path.relpath(os.path.join(d, f), ROOT).replace(os.sep, '/'))
    return sorted(out)

def gh(method, path, body=None):
    req = urllib.request.Request(
        f'https://api.github.com/repos/{REPO}{path}', method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': f"Bearer {os.environ['GITHUB_TOKEN']}",
                 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
                 'User-Agent': 'knowkin-deploy'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        sys.exit(f'GitHub APIエラー {e.code} {method} {path}: {e.read().decode()[:300]}')

def main():
    args = [a for a in sys.argv[1:] if a != '--dry-run']
    dry = '--dry-run' in sys.argv
    message = args[0] if args else 'knowkinを更新'

    # 1. チェック。失敗したらpushしない
    if subprocess.run(['node', os.path.join(ROOT, 'dev/smoke.mjs')], cwd=ROOT).returncode != 0:
        sys.exit(1)

    targets = files()
    if dry:
        print('\n[dry-run] push対象:'); [print('  ' + f) for f in targets]; return
    if not os.environ.get('GITHUB_TOKEN'):
        sys.exit('GITHUB_TOKEN が設定されていません')

    # 2. BUILD_TAG を更新（/health で確認できる）
    tag = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).strftime('%Y%m%d-%H%M%S')
    with open(os.path.join(ROOT, 'src/build.js'), 'w') as f:
        f.write(f"// dev/deploy.py がデプロイのたびに書き換える\nexport const BUILD_TAG = '{tag}';\n")

    # 3. 1コミットでpush（Git Data API）
    ref = gh('GET', f'/git/ref/heads/{BRANCH}')
    base_sha = ref['object']['sha']
    base_tree = gh('GET', f'/git/commits/{base_sha}')['tree']['sha']
    tree = []
    for p in targets:
        with open(os.path.join(ROOT, p), 'rb') as f:
            blob = gh('POST', '/git/blobs', {'content': base64.b64encode(f.read()).decode(), 'encoding': 'base64'})
        tree.append({'path': p, 'mode': '100755' if p.endswith('.py') else '100644', 'type': 'blob', 'sha': blob['sha']})
    new_tree = gh('POST', '/git/trees', {'base_tree': base_tree, 'tree': tree})
    if new_tree['sha'] == base_tree:
        print('\n変更がないため、pushしませんでした。'); return
    commit = gh('POST', '/git/commits', {'message': f'{message} (build {tag})', 'tree': new_tree['sha'], 'parents': [base_sha]})
    gh('PATCH', f'/git/refs/heads/{BRANCH}', {'sha': commit['sha']})
    print(f"\npushしました：{commit['sha'][:7]}  build {tag}")
    print('Railwayが自動でデプロイします。/health の build が上の値になれば反映完了です。')

if __name__ == '__main__':
    main()

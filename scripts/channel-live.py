"""채널 도착 실측 — 진짜 Claude Code 로 이 플러그인을 띄워(로그인 없이) 두 장면을 본다. 정기 시험(meshwork-app engines-daily)이 부른다.

  정상 — 개발 채널로 켜면 첫 알림(로그인 안내)이 세션에 들어가고 훅이 「들어감」 을 적는다 → 받기 계속
  막힘 — 승인 목록에 없는 채널(--channels)은 Claude Code 가 오류 없이 버린다 → 플러그인이 알아채고 받기를 멈춘다(서버가 보관)

Claude Code 가 채널 · 훅의 모양을 바꾸면 여기서 먼저 깨진다(⑨ 수정 B · 실측 2.1.314).
쓰는 법: ANTHROPIC_API_KEY 를 환경에 두고 `python3 scripts/channel-live.py [플러그인 저장소]` — 키는 어디에도 찍지 않는다.
필요: claude · tmux · node. 임시 설정 폴더만 쓴다(사용자 설정 · 신뢰 목록에 닿지 않음).
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

REPO = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..'))
CLAUDE = shutil.which('claude')
TMUX = shutil.which('tmux')
KEY = os.environ.get('ANTHROPIC_API_KEY', '')
MODEL = os.environ.get('MW_LIVE_MODEL', 'claude-haiku-5-5')
SOCK = 'mwchanlive'
if not (CLAUDE and TMUX and KEY):
    sys.exit('claude · tmux · ANTHROPIC_API_KEY 가 필요합니다')

base = {k: v for k, v in os.environ.items() if not k.startswith('CLAUDE_CODE') and k not in ('CLAUDECODE', 'TMUX')}


def tmux(*a, env=None):
    return subprocess.run([TMUX, '-L', SOCK, *a], capture_output=True, text=True, env=env or base)


def screen():
    return tmux('capture-pane', '-p', '-t', 'p').stdout


def wait(pred, secs):
    end = time.time() + secs
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.5)
    return False


def states(home):
    out = []
    for f in glob.glob(os.path.join(home, 'state-*.json')):
        try:
            d = json.load(open(f))
            out.append({k: d.get(k) for k in ('team', 'link', 'stopped')})
        except Exception:
            pass
    return out


root = tempfile.mkdtemp(prefix='mw-chan-live-')
cfg = os.path.join(root, 'cfg')
cwd = os.path.realpath(os.path.join(root, 'work'))
plug = os.path.join(root, 'meshwork')
os.makedirs(cfg)
os.makedirs(cwd)
shutil.copytree(REPO, plug, ignore=shutil.ignore_patterns('node_modules', '.git', 'docs'))
with open(os.path.join(cfg, '.claude.json'), 'w') as f:
    json.dump({
        'hasCompletedOnboarding': True, 'theme': 'dark', 'autoUpdates': False,
        'customApiKeyResponses': {'approved': [KEY[-20:]], 'rejected': []},
        'projects': {cwd: {'hasTrustDialogAccepted': True, 'hasCompletedProjectOnboarding': True}},
    }, f)

result = {'claude': subprocess.run([CLAUDE, '--version'], capture_output=True, text=True).stdout.strip()}
ok = True
try:
    for name, flag in [('정상', '--dangerously-load-development-channels'), ('막힘', '--channels')]:
        home = os.path.join(root, f'home-{len(result)}')
        os.makedirs(home)
        # 쉬는 중 기다림은 기본 1분 — 시험은 10초로(판정 흐름만 본다)
        env = dict(base, CLAUDE_CONFIG_DIR=cfg, MESHWORK_HOME=home, MESHWORK_NO_BROWSER='1',
                   MESHWORK_CHANNEL_WAIT_MS='10000')
        tmux('kill-server')
        tmux('new-session', '-d', '-s', 'p', '-x', '200', '-y', '50', '-c', cwd,
             CLAUDE, '--plugin-dir', plug, '--model', MODEL, flag, 'plugin:meshwork@inline', env=env)
        if wait(lambda: 'developmentchannels' in screen().replace(' ', '').lower(), 20):
            tmux('send-keys', '-t', 'p', 'Enter')
        if name == '정상':
            good = wait(lambda: glob.glob(os.path.join(home, 'chan-*.seen'))
                        and any(s['team'] and s['link'] == 'login' for s in states(home)), 60)
        else:
            good = wait(lambda: any(s['stopped'] == 'channel' for s in states(home)), 60)
        result[name] = {'ok': bool(good), 'states': states(home), 'files': sorted(os.listdir(home)),
                        'screen': [l.strip()[:160] for l in screen().splitlines() if l.strip()][-8:]}
        ok = ok and bool(good)
        tmux('kill-server')
        time.sleep(1)
finally:
    tmux('kill-server')
    shutil.rmtree(root, ignore_errors=True)

print(json.dumps(result, ensure_ascii=False, indent=1))
sys.exit(0 if ok else 1)

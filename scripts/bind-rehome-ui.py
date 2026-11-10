# -*- coding: utf-8 -*-
"""
bind-rehome-ui.py — 把「会话」Tab 的上游开关绑定到接管模式。

幂等，可重复执行；WorkDaddy 升级覆盖 inject.js 后重跑即可重新应用。

改动：
  - 「自动同步所有会话」复选框改名为「接管会话归属」，状态绑定 rehomeEnabled
  - 点击走 /api/rehome/config（后端已把 /api/sessions/auto-copy-all 映射过来）
  - 移除后加的重复复选框 #wbs-sess-rehome
  - 删除上游 toggleAutoCopyAll / updateAutoCopyAllButton
  - 首次引导弹窗文案与行为同步

用法：python scripts/bind-rehome-ui.py [inject.js 路径]
"""
import sys
from pathlib import Path

TARGET = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name('inject.js')

# (old, new, expected_count)
R = []

R.append((
    r'''<span>切换账号自动同步所有会话</span>''',
    r'''<span>切换账号自动接管会话归属</span>''', 1))

R.append((
    r'''aria-label="自动同步所有会话" title="切换账号时自动同步当前账号的所有会话，包括之后新增的会话"''',
    r'''aria-label="接管会话归属" title="切换账号时把本机会话原地改为当前账号：不复制、不改会话 ID，始终只有一份"''', 1))

R.append((
    r'''<span class="wbs-sess-auto-all-label">自动同步所有会话</span>''',
    r'''<span class="wbs-sess-auto-all-label">接管会话归属</span>''', 1))

R.append((
    r'''        '<button class="wbs-sess-auto-all" type="button" id="wbs-sess-rehome" role="checkbox" aria-checked="false" aria-label="接管会话归属" title="切换账号时把本机会话原地改为当前账号：不复制、不改会话 ID，会话与工作区天然共享">' +
        '<span class="wbs-sess-auto-all-box" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="2"/><path class="wbs-sess-auto-all-check" d="m4.5 8 2.2 2.2L11.5 5.5"/></svg></span>' +
        '<span class="wbs-sess-auto-all-label">接管会话归属</span>' +
        '</button>' +
''', '', 1))

R.append((
    r'''batchMode: false, autoCopy: null, autoCopyAll: false, rehomeEnabled: false, rehomeBusy: false, ''',
    r'''batchMode: false, autoCopy: null, rehomeEnabled: false, rehomeBusy: false, ''', 1))

R.append((
    r'''!sessionsState.autoCopyAllBusy && !sessionsState.autoSyncAutomationsBusy &&''',
    r'''!sessionsState.rehomeBusy && !sessionsState.autoSyncAutomationsBusy &&''', 1))

R.append((
    r'''sessionsState.autoCopy, sessionsState.autoCopyAll]) : null;''',
    r'''sessionsState.autoCopy, sessionsState.rehomeEnabled]) : null;''', 1))

R.append((
    r'''sessionsState.autoCopy, sessionsState.autoCopyAll])) return;''',
    r'''sessionsState.autoCopy, sessionsState.rehomeEnabled])) return;''', 1))

R.append((
    r'''nextAutoCopy, !!(d && d.autoCopyAll)])) return;''',
    r'''nextAutoCopy, !!(d && d.rehomeEnabled)])) return;''', 1))

R.append((
    r'''        sessionsState.autoCopyAll = !!(d && d.autoCopyAll);
        sessionsState.rehomeEnabled = !!(d && d.rehomeEnabled);''',
    r'''        sessionsState.rehomeEnabled = !!(d && d.rehomeEnabled);''', 1))

R.append((
    r'''if (sessionsState.autoCopyAll || !canEditAutoCopy(uid)) return '';''',
    r'''if (sessionsState.rehomeEnabled || !canEditAutoCopy(uid)) return '';''', 1))

R.append((
    r'''if (sessionsState.autoCopyAll) return filteredSessions().length;''',
    r'''if (sessionsState.rehomeEnabled) return filteredSessions().length;''', 1))

R.append((
    r'''    function updateAutoCopyAllButton() {
      if (!sessionsPane) return;
      var button = sessionsPane.querySelector('#wbs-sess-auto-all');
      if (!button) return;
      var enabled = !!sessionsState.autoCopyAll;
      button.disabled = !!sessionsState.batchMode || !!sessionsState.autoCopyAllBusy;
      button.classList.toggle('active', enabled);
      button.setAttribute('aria-checked', enabled ? 'true' : 'false');
    }
''', '', 1))

R.append((
    r'''    function toggleAutoCopyAll(enabled) {
      var button = sessionsPane && sessionsPane.querySelector('#wbs-sess-auto-all');
      if (!button || button.disabled) return;
      var previous = !!sessionsState.autoCopyAll;
      sessionsState.autoCopyAll = !!enabled;
      sessionsState.autoCopyAllBusy = true;
      renderSessions();
      api('/api/sessions/auto-copy-all', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !!enabled }),
      }).then(function (response) {
        sessionsState.autoCopyAll = !!(response && response.autoCopyAll);
        sessionsState.autoCopyAllBusy = false;
        renderSessions();
        toast(sessionsState.autoCopyAll ? '已开启自动同步所有会话' : '已关闭自动同步所有会话', false, root);
      }).catch(function (e) {
        sessionsState.autoCopyAll = previous;
        sessionsState.autoCopyAllBusy = false;
        renderSessions();
        toast('自动同步所有会话设置失败: ' + (e.message || e), true, root);
      });
    }
''', '', 1))

R.append((
    r'''      var button = sessionsPane.querySelector('#wbs-sess-rehome');''',
    r'''      var button = sessionsPane.querySelector('#wbs-sess-auto-all');''', 1))

R.append((
    r'''      var button = sessionsPane && sessionsPane.querySelector('#wbs-sess-rehome');''',
    r'''      var button = sessionsPane && sessionsPane.querySelector('#wbs-sess-auto-all');''', 1))

R.append((
    r'''      updateAutoCopyAllButton();
      if (typeof updateRehomeButton === 'function') updateRehomeButton();''',
    r'''      if (typeof updateRehomeButton === 'function') updateRehomeButton();''', 2))

R.append((
    r'''            updateAutoCopyAllButton();
            updateSessCount();''',
    r'''            updateRehomeButton();
            updateSessCount();''', 1))

R.append((
    r'''          if (typeof sessionsState !== 'undefined' && sessionsState) sessionsState.autoCopyAll = enabled;''',
    r'''          if (typeof sessionsState !== 'undefined' && sessionsState) sessionsState.rehomeEnabled = enabled;''', 1))

R.append((
    r'''      var autoCopyAllBtn = sessionsPane.querySelector('#wbs-sess-auto-all');
      if (autoCopyAllBtn) {
        autoCopyAllBtn.addEventListener('click', function () {
          toggleAutoCopyAll(autoCopyAllBtn.getAttribute('aria-checked') !== 'true');
        });
      }
''', '', 1))

R.append((
    r'''      var rehomeBtn = sessionsPane.querySelector('#wbs-sess-rehome');''',
    r'''      var rehomeBtn = sessionsPane.querySelector('#wbs-sess-auto-all');''', 1))


def main():
    src = TARGET.read_text(encoding='utf-8')
    if 'aria-label="接管会话归属"' in src and 'wbs-sess-rehome' not in src and 'function toggleAutoCopyAll' not in src:
        print('already applied, nothing to do:', TARGET)
        return 0
    for old, new, expected in R:
        n = src.count(old)
        if n != expected:
            print('MISMATCH count=%d expected=%d for: %r' % (n, expected, old[:90]))
            return 1
        src = src.replace(old, new)
    TARGET.write_text(src, encoding='utf-8')
    print('applied %d replacements -> %s' % (len(R), TARGET))
    return 0


if __name__ == '__main__':
    sys.exit(main())

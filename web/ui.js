// The verifier page (web/build.mjs puts it after the library): reads the files chosen or dropped and the pasted
// text, runs fairshoe.collect and fairshoe.verifyBundle on them, as fairshoe-verify does, and shows the report.
// Records are data from a server: they are shown as text, never as markup.
(() => {
  const $ = (id) => document.getElementById(id);
  const picker = $('files');
  const drop = $('drop');
  const pasted = $('text');
  const result = $('result');
  const verdict = $('verdict');
  const list = $('checks');
  const json = $('json');
  /** Files dropped on the page: { name, text }. */
  let dropped = [];

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const noteDropped = () => {
    drop.textContent = dropped.length === 0 ? 'or drop JSON files here' : `${dropped.map((f) => f.name).join(', ')} (dropped)`;
  };

  const say = (status, text) => {
    result.hidden = false;
    verdict.className = `verdict ${status}`;
    verdict.textContent = text;
  };

  const show = (report) => {
    const failed = report.checks.filter((c) => c.status === 'failed').length;
    const pending = report.checks.filter((c) => c.status === 'pending').length;
    const more = pending ? ` ${pending} not checkable yet (pending).` : '';
    if (report.status === 'provable') say('provable', `Provable: every check is ok and bound to what you kept.${more}`);
    else if (report.status === 'ok') say('ok', `ok, not provable: the records agree, but something only you know is missing (listed below).${more}`);
    else if (report.status === 'pending') say('pending', `Pending: nothing contradicts what you kept, but no shoe, round or pair can be checked before its reveal.${more}`);
    else say('failed', `FAILED: ${failed} of ${report.checks.length} checks found a problem (listed below).${more}`);
    const why = fairshoe.reasons(report);
    list.replaceChildren(
      ...report.checks.map((c, i) => {
        const item = el('li', `check ${c.status}`);
        item.append(el('span', 'status', c.status === 'failed' ? 'FAILED' : c.status), el('span', 'label', c.label));
        const reasons = [...why[i].errors.map((e) => ['error', e]), ...why[i].unproven.map((u) => [c.status === 'pending' ? 'pending' : 'not provable', u])];
        if (reasons.length > 0) {
          const ul = el('ul', 'reasons');
          for (const [kind, text] of reasons) ul.append(el('li', kind === 'error' ? 'error' : 'unproven', `${kind}: ${text}`));
          item.append(ul);
        }
        return item;
      }),
    );
    json.textContent = JSON.stringify(report, null, 2);
  };

  const fail = (message) => {
    say('failed', message);
    list.replaceChildren();
    json.textContent = '';
  };

  const inputs = async () => {
    const out = [];
    for (const f of picker.files ?? []) out.push({ name: f.name, text: await f.text() });
    out.push(...dropped);
    if (pasted.value.trim() !== '') out.push({ name: 'pasted text', text: pasted.value });
    return out;
  };

  $('verify').addEventListener('click', async () => {
    try {
      const texts = await inputs();
      if (texts.length === 0) {
        fail('Nothing to verify: choose or drop JSON files, or paste JSON.');
        return;
      }
      const values = texts.map(({ name, text }) => {
        try {
          return { name, value: JSON.parse(text) };
        } catch (err) {
          throw new fairshoe.InputError(`${name}: not JSON (${err instanceof Error ? err.message : String(err)})`);
        }
      });
      show(fairshoe.verifyBundle(fairshoe.collect(values)));
    } catch (err) {
      fail(err instanceof fairshoe.InputError ? `The input could not be read: ${err.message}` : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  $('clear').addEventListener('click', () => {
    picker.value = '';
    pasted.value = '';
    dropped = [];
    noteDropped();
    result.hidden = true;
    list.replaceChildren();
    json.textContent = '';
  });

  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add('over');
    });
  }
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (event) => {
    event.preventDefault();
    drop.classList.remove('over');
    for (const f of event.dataTransfer?.files ?? []) dropped.push({ name: f.name, text: await f.text() });
    noteDropped();
  });

  noteDropped();
})();

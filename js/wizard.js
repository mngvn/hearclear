// A small guided tour: spotlights parts of the page and explains them step by step.
const $ = (s) => document.querySelector(s);

export function createWizard(steps, { onFinish } = {}) {
  const root = $('#wizard');
  const spot = $('#spotlight');
  const card = root.querySelector('.wizard-card');
  const stepEl = $('#wizard-step');
  const title = $('#wizard-title');
  const body = $('#wizard-body');
  const dots = $('#wizard-dots');
  const back = $('#wizard-back');
  const next = $('#wizard-next');
  const skip = $('#wizard-skip');
  let i = 0;
  let open = false;

  function place() {
    if (!open) return;
    const step = steps[i];
    const target = step.target ? document.querySelector(step.target) : null;
    card.classList.remove('top', 'center');
    if (!target || !target.getClientRects().length) {
      root.classList.add('no-target');
      card.classList.add('center');
      return;
    }
    root.classList.remove('no-target');
    const r = target.getBoundingClientRect();
    const pad = 6;
    Object.assign(spot.style, {
      left: `${r.left - pad}px`, top: `${r.top - pad}px`,
      width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
    });
    if (r.top + r.height / 2 > window.innerHeight * 0.5) card.classList.add('top');
  }

  function render() {
    const step = steps[i];
    stepEl.textContent = `Step ${i + 1} of ${steps.length}`;
    title.textContent = step.title;
    body.innerHTML = step.html;
    dots.innerHTML = steps.map((_, k) => `<span class="${k === i ? 'on' : ''}"></span>`).join('');
    back.hidden = i === 0;
    next.textContent = i === steps.length - 1 ? 'Done' : 'Next';
    skip.textContent = i === steps.length - 1 ? 'Close' : 'Skip tour';
    const target = step.target ? document.querySelector(step.target) : null;
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    place();
    setTimeout(place, 350);
    next.focus();
  }

  function close(finished) {
    open = false;
    root.hidden = true;
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    document.removeEventListener('keydown', onKey);
    onFinish?.(finished);
  }

  function onKey(e) {
    if (e.key === 'Escape') close(false);
    else if (e.key === 'ArrowRight') next.click();
    else if (e.key === 'ArrowLeft' && i > 0) back.click();
  }

  back.onclick = () => { if (i > 0) { i--; render(); } };
  next.onclick = () => { if (i < steps.length - 1) { i++; render(); } else close(true); };
  skip.onclick = () => close(false);

  return {
    start(at = 0) {
      i = at;
      open = true;
      root.hidden = false;
      window.addEventListener('resize', place);
      window.addEventListener('scroll', place, true);
      document.addEventListener('keydown', onKey);
      render();
    },
  };
}

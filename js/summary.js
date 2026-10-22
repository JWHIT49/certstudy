// Plain-language counts of what a set of progress documents holds. Shown when a device that already has progress meets an account,
// so the learner can see what is on each side before choosing what happens to it.

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const whole = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** entries: [key, value] pairs (documents from this device or from the cloud). The values are not trusted: this only counts. */
export function summarize(entries) {
  const out = { answered: 0, skills: 0, sections: 0 };
  for (const [key, value] of entries) {
    if (/^qstats\./.test(key) && isPlain(value)) {
      for (const stat of Object.values(value)) if (isPlain(stat)) out.answered += whole(stat.a);
    } else if (/^skills\./.test(key) && isPlain(value)) {
      out.skills += Object.keys(value).length;
    } else if (/^guide\./.test(key) && isPlain(value) && isPlain(value.read)) {
      out.sections += Object.keys(value.read).length;
    }
  }
  return out;
}

export const isEmpty = (s) => s.answered === 0 && s.skills === 0 && s.sections === 0;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function describeSummary(s) {
  if (isEmpty(s)) return 'nothing yet';
  return [plural(s.answered, 'question answered', 'questions answered'), plural(s.skills, 'skill rated', 'skills rated'), plural(s.sections, 'section read', 'sections read')].join(' \u00b7 ');
}

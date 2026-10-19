import { libraryView } from './views/library.js';
import { certHomeView } from './views/cert.js';
import { guideListView, guideTocView, guideReaderView } from './views/guide.js';
import { practiceView } from './views/practice.js';
import { runView, reviewView, questionView } from './views/runner.js';
import { resultsView } from './views/results.js';
import { skillsView } from './views/skills.js';
import { searchView } from './views/search.js';
import { settingsView } from './views/settings.js';

export function registerRoutes(on) {
  on('/', libraryView);
  on('/settings', settingsView);
  on('/c/:pack', certHomeView);
  on('/c/:pack/guide', guideListView);
  on('/c/:pack/guide/:gid', guideTocView);
  on('/c/:pack/guide/:gid/:sid', guideReaderView);
  on('/c/:pack/practice', practiceView);
  on('/c/:pack/run', runView);
  on('/c/:pack/results/:sid', resultsView);
  on('/c/:pack/review/:sid', reviewView);
  on('/c/:pack/skills', skillsView);
  on('/c/:pack/search', searchView);
  on('/c/:pack/q/:examId/:qid', questionView);
}

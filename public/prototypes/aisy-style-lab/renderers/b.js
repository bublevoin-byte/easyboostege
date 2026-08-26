import { renderScreen as renderFoundationScreen } from './foundation.js';

const screenClasses = {
  today: 'b-instrument--today',
  task: 'b-instrument--task',
  review: 'b-instrument--review',
  progress: 'b-instrument--progress',
};

export function renderScreen(viewModel, runtime = {}) {
  const screenClass = screenClasses[viewModel.screen] || screenClasses.today;
  return renderFoundationScreen(viewModel, runtime, {
    surfaceClass: `b-instrument ${screenClass}`,
  });
}

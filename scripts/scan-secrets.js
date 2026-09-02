import { fileURLToPath } from 'node:url';
import {
  gitTrackedFiles,
  readCandidateFileManifest,
  verifyDockerBuildContext,
} from './verify-docker-context.js';
import { assertNoSecretPatterns } from './secret-scan-contract.js';

const projectDirectory=fileURLToPath(new URL('..',import.meta.url));
const DEFAULT_CANDIDATE_MANIFEST='scripts/aisy-release-candidate-files.json';
const manifestFlag=process.argv.indexOf('--candidate-manifest');
if(manifestFlag!==-1&&(!process.argv[manifestFlag+1]||process.argv.length!==manifestFlag+2)){
  console.error('Usage: node scripts/scan-secrets.js [--candidate-manifest <repo-relative-json>]');process.exit(2)}
const candidateManifest=manifestFlag===-1?DEFAULT_CANDIDATE_MANIFEST:process.argv[manifestFlag+1];
try {
  const tracked=gitTrackedFiles(projectDirectory);
  const releaseCandidate=readCandidateFileManifest({projectDirectory});
  const context=verifyDockerBuildContext({
    projectDirectory, trackedFiles:tracked, candidateFiles:releaseCandidate,
  });
  const candidate=readCandidateFileManifest({projectDirectory,manifestName:candidateManifest});
  const files=[...new Set([...tracked,...candidate])];
  const scanned=assertNoSecretPatterns({
    rootDirectory:projectDirectory,
    files,
    scanAllBytes:true,
  });
  console.log(`Secret scan passed (${tracked.length} tracked + ${candidate.length} explicit candidate files checked; ${context.reachable.length} Docker COPY inputs verified; ${scanned.files} unique files read).`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

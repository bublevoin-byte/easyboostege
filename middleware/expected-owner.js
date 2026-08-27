const OWNER_HEADER = 'x-easyboost-expected-owner';

export function requireExpectedOwner(req, res) {
  const authorization = String(req.get('authorization') || '');
  const bearerAuthenticated = /^Bearer\s+\S+$/u.test(authorization);
  const raw = req.get(OWNER_HEADER);
  if (raw == null) {
    if (bearerAuthenticated) return true;
    res.status(400).json({ error: { code: 'EXPECTED_OWNER_REQUIRED', message: 'Expected account is required.' } });
    return false;
  }
  const expected = String(raw).trim();
  if (!expected || expected.length > 64 || expected !== req.user) {
    res.status(409).json({ error: { code: 'OWNER_CHANGED', message: 'Authenticated account changed.' } });
    return false;
  }
  return true;
}

// Compatibility seam for contracts that predate owner-bound browser projections. New UI callers
// always send the captured owner; legacy authenticated clients keep working when the header is
// absent, while any supplied mismatch still fails before private work starts.
export function validateExpectedOwner(req, res) {
  const raw = req.get(OWNER_HEADER);
  if (raw == null) return true;
  const expected = String(raw).trim();
  if (!expected || expected.length > 64 || expected !== req.user) {
    res.status(409).json({ error: { code: 'OWNER_CHANGED', message: 'Authenticated account changed.' } });
    return false;
  }
  return true;
}

export function bindResponseOwner(res, owner) {
  res.setHeader('X-EasyBoost-Response-Owner', owner);
}

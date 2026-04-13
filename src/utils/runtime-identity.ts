export type RuntimeIdentity = {
  name: string;
  role: 'development' | 'production' | 'unknown';
  repoPath: string;
  source: 'env' | 'path' | 'default';
  notes?: string;
};

function normalizeRole(value?: string | null): RuntimeIdentity['role'] {
  const raw = value?.trim().toLowerCase();
  if (!raw) {
    return 'unknown';
  }
  if (raw === 'dev' || raw === 'development') {
    return 'development';
  }
  if (raw === 'prod' || raw === 'production') {
    return 'production';
  }
  return 'unknown';
}

export function inferRuntimeIdentityFromPath(repoPath: string): RuntimeIdentity {
  const normalized = repoPath.replace(/\\/g, '/');
  if (normalized.includes('/Python_Dev/')) {
    return {
      name: 'dev',
      role: 'development',
      repoPath,
      source: 'path',
    };
  }
  if (normalized.includes('/Python/')) {
    return {
      name: 'prod',
      role: 'production',
      repoPath,
      source: 'path',
    };
  }
  return {
    name: 'unknown',
    role: 'unknown',
    repoPath,
    source: 'default',
  };
}

export function getRuntimeIdentity(repoPath: string = process.cwd()): RuntimeIdentity {
  const envName = process.env.DEXTER_RUNTIME_NAME?.trim();
  const envRole = normalizeRole(process.env.DEXTER_RUNTIME_ROLE);
  const envNotes = process.env.DEXTER_RUNTIME_NOTES?.trim();

  if (envName || envRole !== 'unknown' || envNotes) {
    return {
      name: envName || (envRole === 'unknown' ? 'custom' : envRole === 'production' ? 'prod' : 'dev'),
      role: envRole,
      repoPath,
      source: 'env',
      notes: envNotes || undefined,
    };
  }

  return inferRuntimeIdentityFromPath(repoPath);
}

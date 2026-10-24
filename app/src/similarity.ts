const APOSTROPHES = /['’]/g;
const PUNCTUATION = /[.,'’`"“”\-–—\/\\()&+@#$%^*=~!?;:\[\]{}<>|_،؛؟۔]/g;

export function normaliseName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(PUNCTUATION, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(
        current[j - 1] + 1, // insert
        previous[j] + 1, // delete
        substitution
      );
    }
    [previous, current] = [current, previous];
  }

  return previous[b.length];
}

function allowedEdits(length: number): number {
  if (length <= 4) return 1;
  if (length <= 8) return 2;
  return 3;
}

function closeEnough(a: string, b: string): boolean {
  return editDistance(a, b) <= allowedEdits(Math.min(a.length, b.length));
}

function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - editDistance(a, b) / longest;
}

export function nameMatchScore(rawQuery: string, rawCandidate: string): number {
  const query = normaliseName(rawQuery);
  const candidate = normaliseName(rawCandidate);
  if (!query || !candidate) return 0;
  if (query === candidate) return 1;

  const shorter = query.length <= candidate.length ? query : candidate;
  const longer = query.length <= candidate.length ? candidate : query;
  if (shorter.length >= 3 && longer.startsWith(shorter)) return 0.9;

  if (closeEnough(query, candidate)) {
    return Math.max(0.75, similarity(query, candidate));
  }

  const queryTokens = query.split(' ');
  const candidateTokens = candidate.split(' ');

  if (
    queryTokens.every((queryToken) =>
      candidateTokens.some((candidateToken) =>
        closeEnough(queryToken, candidateToken)
      )
    )
  ) {
    const tokenScores = queryTokens.map((queryToken) =>
      Math.max(
        ...candidateTokens.map((candidateToken) =>
          similarity(queryToken, candidateToken)
        )
      )
    );
    const average =
      tokenScores.reduce((sum, score) => sum + score, 0) / tokenScores.length;
    return Math.max(0.75, average * 0.95);
  }

  return 0;
}

export function rankSimilarNames<T extends { name: string }>(
  query: string,
  rows: T[],
  limit = 3
): T[] {
  return rows
    .map((row) => ({ row, score: nameMatchScore(query, row.name) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name))
    .slice(0, limit)
    .map((hit) => hit.row);
}

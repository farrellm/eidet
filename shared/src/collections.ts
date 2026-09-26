/**
 * `Map.groupBy`, which the phone's Safari may predate. Keys keep first-seen
 * order and each group keeps input order.
 */
export function groupBy<T, K>(items: Iterable<T>, key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>()
  for (const item of items) {
    const k = key(item)
    const group = groups.get(k)
    if (group) group.push(item)
    else groups.set(k, [item])
  }
  return groups
}

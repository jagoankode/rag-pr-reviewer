import { createHash } from 'crypto';
// Reviewed content bindings, not backend IDs. Any edit requires revalidation.
const bindings: Record<string, string> = {
  '72f9e1482acbb7dbd173107c90a933013fb62ac2cbb183cb49e5371bb5329d75': 'naming',
  'a8a60d70945b419c451274fd4c0d8a311e880899e27c4af0e70a25f364a88860': 'scaffold',
  '7782ec29ac5f26771baf908e7e57bfe24fe8dfba5fc7838863787fc0844bba09': 'typing',
  '5f8967e3eb9fd5f5910a0e0f04fa760f7a3d294ed249a16c8b895fc882da0ded': 'naming',
  '0c319262d646ed291b4ff149751d0cf2e364a36e82aed14e40aa902b43a10a05': 'scaffold',
  'ddb3e12f3279f4b9a48dedab8addea54a8255b56ead0f3857d846dc5524c8802': 'no-var',
  'fc70b7b1097988f9ed7b09047d3139165c21709058ad2b07b3a02cde11e8979a': 'typing',
};
export function reviewedChecker(content: string): string | undefined {
  return bindings[createHash('sha256').update(content).digest('hex')];
}

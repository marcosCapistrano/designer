import { describe, expect, it } from 'vitest';
import { LexUnclear, MAX_NESTING, lexShell } from './shell-lexer.js';

/** The words of each command, as `text` (with a `~` after the text when the word is dynamic). */
function view(input: string): string[][] {
  return lexShell(input).map((c) => c.words.map((w) => (w.dynamic ? `${w.text}~` : w.text)));
}

describe('lexShell words', () => {
  it('removes quotes and escapes', () => {
    expect(view(`g"it" 'pu'sh gi\\t`)).toEqual([['git', 'push', 'git']]);
    expect(view('echo "a\\"b" "a\\nb" \'a\\nb\'')).toEqual([['echo', 'a"b', 'a\\nb', 'a\\nb']]);
  });

  it('keeps separators, parentheses and # inside quotes and escapes', () => {
    expect(view('echo "a;b" \'c|d\' e\\;f "(g)" \\(h\\) "i # j"')).toEqual([
      ['echo', 'a;b', 'c|d', 'e;f', '(g)', '(h)', 'i # j'],
    ]);
  });

  it('splits on every unquoted separator and grouping character', () => {
    expect(view('a; b && c || d | e |& f & g\nh (i) { j; }')).toEqual([
      ['a'],
      ['b'],
      ['c'],
      ['d'],
      ['e'],
      ['f'],
      ['g'],
      ['h'],
      ['i'],
      ['{', 'j'],
      ['}'],
    ]);
  });

  it('drops redirections and their targets, including quoted ones', () => {
    expect(view('a >"x;y" b 2>&1 c &>log d <<< e >| f 3<g')).toEqual([['a', 'b', 'c', 'd']]);
    expect(view('>out a')).toEqual([['a']]);
  });

  it('keeps a number that is not a file descriptor', () => {
    expect(view('echo 2 3>x "4">y')).toEqual([['echo', '2', '4']]);
  });

  it('joins a backslash-newline and ends a comment at the newline', () => {
    expect(view('git \\\npush')).toEqual([['git', 'push']]);
    expect(view("echo a # it's\ngit push")).toEqual([['echo', 'a'], ['git', 'push']]);
    expect(view('echo a#b')).toEqual([['echo', 'a#b']]);
  });
});

describe('lexShell dynamic words', () => {
  it('flags $, backticks, substitutions, globs and brace expansion outside single quotes', () => {
    const [cmd] = lexShell('$a "$b" `c` $(d) ${e} $\'f\' *.ts g? [hi] {j,k} {1..3} <(l)').filter((c) => c.words.length > 2);
    expect(cmd?.words).toHaveLength(12);
    expect(cmd?.words.every((w) => w.dynamic)).toBe(true);
  });

  it('does not flag quoted or escaped glob characters, lone brackets, braces or ref syntax', () => {
    const words = lexShell("echo '$a' \"*\" \\* '[x]' [ [[ { } {} stash@{0} a{b} \"{a,b}\" \\{a,b\\}")[0]?.words;
    expect(words?.filter((w) => w.dynamic)).toEqual([]);
  });

  it('tells an expansion from a glob', () => {
    const [cmd] = lexShell('curl $a "b${c}" *.d [e].f {g,h}.i');
    expect(cmd?.words.map((w) => [w.expanded, w.bracketed])).toEqual([
      [false, false],
      [true, false],
      [true, false],
      [false, false],
      [false, true],
      [false, true],
    ]);
  });
});

describe('lexShell substitutions', () => {
  it('lists the commands inside before the command that holds them', () => {
    expect(view('a $(b `c` "$(d)") <(e) >(f)')).toEqual([['c'], ['d'], ['b', '`c`~', '$(d)~'], ['e'], ['f'], ['a', '$(b `c` "$(d)")~', '<(e)~', '>(f)~']]);
  });

  it('reads quotes and escapes inside a substitution on their own', () => {
    expect(view('echo "$(echo ")" ; ssh)"')).toEqual([
      ['echo', ')'],
      ['ssh'],
      ['echo', '$(echo ")" ; ssh)~'],
    ]);
  });

  it('reads ${...} to its own closing brace', () => {
    expect(view('echo ${a:-b}c; git push')).toEqual([['echo', '${a:-b}c~'], ['git', 'push']]);
    expect(view('echo ${a:-$(ssh h)}')).toEqual([['ssh', 'h'], ['echo', '${a:-$(ssh h)}~']]);
  });

  it('reads arithmetic as one expansion where << is a shift', () => {
    expect(view('echo $((1 << 2))\ngit push')).toEqual([['echo', '$((1 << 2))~'], ['git', 'push']]);
    expect(view('(( x = 1 << 2 ))\ngit push')).toEqual([['git', 'push']]);
    expect(view('echo $[1 << 2]\ngit push')).toEqual([['echo', '$[1 << 2]~'], ['git', 'push']]);
  });

  it('lexes backtick bodies after un-escaping them', () => {
    expect(view('echo `echo \\`ssh h\\``')).toEqual([
      ['ssh', 'h'],
      ['echo', '`ssh h`~'],
      ['echo', '`echo \\`ssh h\\``~'],
    ]);
  });
});

describe('lexShell heredocs', () => {
  it('skips the body and goes on with the next line', () => {
    const cmds = lexShell("cat <<'EOF' > f\n* a\nssh h\nf()\nEOF\ngit push");
    expect(cmds.map((c) => c.words.map((w) => w.text))).toEqual([['cat'], ['git', 'push']]);
    expect(cmds.map((c) => c.heredoc)).toEqual([true, false]);
  });

  it('runs the commands in an unquoted body and skips the commands in a quoted one', () => {
    expect(view('cat <<EOF\n$(ssh h)\nEOF')).toEqual([['cat'], ['ssh', 'h']]);
    expect(view("cat <<'EOF'\n$(ssh h)\nEOF")).toEqual([['cat']]);
    expect(view('cat <<EOF\n\\$(ssh h)\nEOF')).toEqual([['cat']]);
  });

  it('honours <<- tabs, several heredocs on one line and a body that is never closed', () => {
    expect(view('cat <<-EOF\n\tx\n\tEOF\ngit push')).toEqual([['cat'], ['git', 'push']]);
    expect(view('cat <<A <<B\na\nA\nb\nB\ngit push')).toEqual([['cat'], ['git', 'push']]);
    expect(view('cat <<EOF\ngit push')).toEqual([['cat']]);
  });
});

describe('lexShell fails closed', () => {
  it.each([
    'echo "open',
    "echo 'open",
    'echo `open',
    'echo $(open',
    'echo ${open',
    'echo $((1+2)',
    'f() { :; }',
    'a=()',
    'echo "${a:-\'b\'}"',
    'echo $((1+2) )',
  ])('throws on %j', (input) => {
    expect(() => lexShell(input)).toThrow(LexUnclear);
  });

  it('throws once nesting passes the limit and not before', () => {
    const nested = (depth: number): string => `${'$('.repeat(depth)}x${')'.repeat(depth)}`;
    expect(() => lexShell(nested(MAX_NESTING))).not.toThrow();
    expect(() => lexShell(nested(MAX_NESTING + 1))).toThrow(LexUnclear);
    expect(() => lexShell('$('.repeat(5000))).toThrow(LexUnclear);
  });
});

/**
 * A quote-aware lexer for the slice of bash that the deploy guard needs.
 *
 * One left-to-right pass finds words, separators, redirections, substitutions and heredocs, so no
 * rule has to look for a `;` or a `(` in raw text. Quotes, backslash escapes, `$(...)`, backticks,
 * `${...}`, arithmetic and heredoc bodies are all understood here and nowhere else.
 *
 * The output is a flat list of simple commands. A command found inside a substitution is a command
 * of its own, listed before the command that contains it. Words that come from an expansion are
 * flagged `dynamic`, because their value is not known until the shell runs.
 *
 * The lexer throws LexUnclear when it cannot tell what bash would do (an unterminated quote, nesting
 * deeper than MAX_NESTING, a function definition, too much work). The guard turns that into a denial.
 */

export interface LexWord {
  /** The word with quotes and escapes removed. An expansion contributes the text it was written as. */
  text: string;
  /** The final value is decided at run time: `$`, a backtick, a substitution, a glob or a brace expansion. */
  dynamic: boolean;
  /** The word contains `$`, a backtick or a substitution (a glob or brace expansion alone does not count). */
  expanded: boolean;
  /** The word has an unquoted bracket glob or brace expansion. */
  bracketed: boolean;
}

export interface LexCommand {
  words: LexWord[];
  /** A heredoc (`<<` or `<<-`) is attached to this command's standard input. */
  heredoc: boolean;
  /** A here-string (`<<<`) is attached to this command's standard input. */
  herestring: boolean;
}

/** The lexer cannot tell what the shell would do with this input. */
export class LexUnclear extends Error {}

/** Substitutions, parameter expansions, arithmetic and `-c` strings may nest this deep. */
export const MAX_NESTING = 32;

type Redirect = 'file' | 'heredoc' | 'heredoc-dash' | null;

interface PendingHeredoc {
  delimiter: string;
  /** `<<-` strips leading tabs from the delimiter line. */
  strip: boolean;
  /** A quoted delimiter turns off expansion in the body. */
  quoted: boolean;
}

interface Shared {
  out: LexCommand[];
  steps: number;
  budget: number;
}

/**
 * Words that may stand before a command inside a compound command: `if ((x))`, `while ...`.
 * `for` and `select` are NOT here: their loop variable (`for case in ...`) must not be read as a
 * keyword. `for ((` arithmetic is recognised from the preceding `for` word instead.
 */
const COMMAND_PREFIX: ReadonlySet<string> = new Set([
  'if',
  'then',
  'else',
  'elif',
  'while',
  'until',
  'do',
  '!',
  '{',
  'time',
]);

/** Characters that turn `(` into an extglob operator (`?(`, `*(`, `+(`, `@(`, `!(`). */
const EXTGLOB_PREFIX = '?*+@!';

function isBlank(ch: string): boolean {
  return ch === ' ' || ch === '\t' || /\s/.test(ch);
}

/** The word being read. Unquoted characters can make it dynamic; quoted ones cannot. */
class WordBuilder {
  text = '';
  dynamic = false;
  expanded = false;
  bracketed = false;
  /** Some part was quoted or escaped (decides whether a heredoc delimiter expands its body). */
  quoted = false;
  /** The last unquoted character was one of `?*+@!`: a `(` right after it is an extglob operator. */
  lastExtglobPrefix = false;
  private onlyDigits = true;
  /** One entry per open unquoted `{`: whether a `,` or `..` has been seen inside it. */
  private readonly braces: boolean[] = [];
  private openBracket = false;
  private prevDot = false;

  /** An unquoted, unescaped character. */
  plain(ch: string): void {
    this.text += ch;
    this.lastExtglobPrefix = EXTGLOB_PREFIX.includes(ch);
    if (ch < '0' || ch > '9') this.onlyDigits = false;
    switch (ch) {
      case '*':
      case '?':
        this.dynamic = true;
        break;
      case '[':
        this.openBracket = true;
        break;
      case ']':
        if (this.openBracket) this.glob();
        break;
      case '{':
        this.braces.push(false);
        break;
      case ',':
        if (this.braces.length > 0) this.braces[this.braces.length - 1] = true;
        break;
      case '.':
        if (this.prevDot && this.braces.length > 0) this.braces[this.braces.length - 1] = true;
        break;
      case '}':
        if (this.braces.pop() === true) this.glob();
        break;
      default:
        break;
    }
    this.prevDot = ch === '.';
  }

  /** A character that is quoted or escaped: it is text, whatever it is. */
  literal(s: string): void {
    this.text += s;
    this.onlyDigits = false;
    this.prevDot = false;
    this.lastExtglobPrefix = false;
  }

  /** `$...`, a backtick or a substitution. `raw` is the source text. */
  expansion(raw: string): void {
    this.text += raw;
    this.dynamic = true;
    this.expanded = true;
    this.onlyDigits = false;
    this.prevDot = false;
    this.lastExtglobPrefix = false;
  }

  quote(): void {
    this.quoted = true;
    this.onlyDigits = false;
  }

  /** Only unquoted digits so far: in front of `<` or `>` it is a file descriptor. */
  isFd(): boolean {
    return this.onlyDigits && this.text !== '';
  }

  /** `{name}` in front of `<` or `>` is a variable-fd redirection target, not the program word. */
  isVarFd(): boolean {
    return !this.dynamic && !this.quoted && /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(this.text);
  }

  finish(): LexWord {
    return { text: this.text, dynamic: this.dynamic, expanded: this.expanded, bracketed: this.bracketed };
  }

  private glob(): void {
    this.dynamic = true;
    this.bracketed = true;
  }
}

/** The command being read in one list (the top level, or the inside of one substitution). */
class ListState {
  words: LexWord[] = [];
  heredoc = false;
  herestring = false;
  redirect: Redirect = null;
  /** Every word so far is a keyword that can stand in front of a command. */
  private prefixOnly = true;
  /** One entry per open `case`: reading `case WORD`, reading its patterns, or reading a clause body. */
  private readonly cases: Array<'head' | 'pattern' | 'body'> = [];
  /** A pattern word has been read in the current case clause (a second bare one is malformed). */
  private patternWord = false;
  /** Open `[[ ]]` conditionals: inside one, `#` is not a comment. */
  private conditional = 0;
  /** The last word pushed to the current command (`for ((` recognises the `for`). */
  private lastPushed: string | null = null;
  private builder: WordBuilder | null = null;

  constructor(
    private readonly pending: PendingHeredoc[],
    private readonly out: LexCommand[],
  ) {}

  word(): WordBuilder {
    if (this.builder === null) this.builder = new WordBuilder();
    return this.builder;
  }

  inWord(): boolean {
    return this.builder !== null;
  }

  /** No word of the current command has been read, or only keywords such as `if`, `then` and `!`. */
  atCommandStart(): boolean {
    return this.prefixOnly;
  }

  /** `((` is arithmetic at a command start, and after `for` (`for ((;;))`). */
  canStartArith(): boolean {
    return this.prefixOnly || this.lastPushed === 'for';
  }

  /** A redirection seen before any program word means the next word is the program, not a keyword. */
  markNotPrefix(): void {
    this.prefixOnly = false;
  }

  /** Inside `[[ ]]` an unquoted `#` is literal, not the start of a comment. */
  inConditional(): boolean {
    return this.conditional > 0;
  }

  /** The current word ends with an extglob prefix char and the next char is `(`. */
  pendingExtglob(): boolean {
    return this.builder !== null && this.builder.lastExtglobPrefix;
  }

  /** A `|` between case alternatives: the next pattern word is allowed again. */
  patternAlt(): void {
    this.patternWord = false;
  }

  /** Drops a bare number that sits right in front of a redirection (the 2 in 2>&1). */
  takeFd(): boolean {
    if (this.builder === null || !this.builder.isFd()) return false;
    this.builder = null;
    return true;
  }

  /** Drops a `{name}` variable-fd target that sits right in front of a redirection operator. */
  takeVarFd(): boolean {
    if (this.builder === null || !this.builder.isVarFd()) return false;
    this.builder = null;
    return true;
  }

  endWord(): void {
    const done = this.builder;
    if (done === null) return;
    this.builder = null;
    const word = done.finish();
    if (this.redirect === 'heredoc' || this.redirect === 'heredoc-dash') {
      this.pending.push({ delimiter: word.text, strip: this.redirect === 'heredoc-dash', quoted: done.quoted });
      this.redirect = null;
      return;
    }
    if (this.redirect === 'file') {
      // The target of a redirection is not a word of the command.
      this.redirect = null;
      return;
    }
    const top = this.cases[this.cases.length - 1];
    if (top === 'pattern') {
      // A case pattern is not a command word. Only `esac` is: it closes the case.
      if (word.text === 'esac' && !done.quoted) {
        this.cases.pop();
        this.patternWord = false;
        return;
      }
      // Two bare pattern words with no `|` between them is not a list bash would accept.
      if (this.patternWord) throw new LexUnclear('malformed case pattern list');
      this.patternWord = true;
      return;
    }
    if (!done.quoted) {
      if (top === 'head' && word.text === 'in' && (this.words.length === 0 || this.words.length >= 2)) {
        // `case WORD in` is not a command; the patterns follow.
        this.cases[this.cases.length - 1] = 'pattern';
        this.patternWord = false;
        this.words = [];
        this.prefixOnly = true;
        return;
      }
      if (this.prefixOnly) {
        if (word.text === 'case') this.cases.push('head');
        else if (word.text === 'esac' && top === 'body') {
          this.cases.pop();
          return;
        }
      }
      if (word.text === '[[') this.conditional++;
      else if (word.text === ']]' && this.conditional > 0) this.conditional--;
    }
    this.words.push(word);
    this.lastPushed = word.text;
    if (!COMMAND_PREFIX.has(word.text)) this.prefixOnly = false;
  }

  /** Reading the patterns of a case clause: nothing here is a command. */
  inPattern(): boolean {
    return this.cases[this.cases.length - 1] === 'pattern';
  }

  /** The `)` that ends a case pattern list. */
  patternEnd(): void {
    if (this.inPattern()) {
      this.cases[this.cases.length - 1] = 'body';
      this.patternWord = false;
    }
  }

  /** `;;`, `;&` or `;;&` ends a clause: the next words are patterns again, or `esac`. */
  clauseEnd(): void {
    if (this.cases[this.cases.length - 1] === 'body') {
      this.cases[this.cases.length - 1] = 'pattern';
      this.patternWord = false;
    }
  }

  endCommand(): void {
    this.endWord();
    if (!this.inPattern() && this.words.length > 0) {
      this.out.push({ words: this.words, heredoc: this.heredoc, herestring: this.herestring });
    }
    this.words = [];
    this.heredoc = false;
    this.herestring = false;
    this.redirect = null;
    this.prefixOnly = true;
    this.lastPushed = null;
  }
}

class Lexer {
  private pos = 0;
  /** Heredocs whose bodies start after the next newline. A substitution gets its own list. */
  private pending: PendingHeredoc[] = [];

  constructor(
    private readonly src: string,
    private nest: number,
    private readonly shared: Shared,
  ) {}

  run(): void {
    this.parseList(false);
  }

  /** Reads the text of an unquoted heredoc body: only its substitutions are commands. */
  runHeredocBody(): void {
    const src = this.src;
    while (this.pos < src.length) {
      this.tick();
      const ch = src.charAt(this.pos);
      if (ch === '\\') {
        this.pos += 2;
      } else if (ch === '$') {
        this.scanDollar(true, null);
      } else if (ch === '`') {
        this.pos++;
        this.scanBacktick(false);
      } else {
        this.pos++;
      }
    }
  }

  private tick(): void {
    if (++this.shared.steps > this.shared.budget) throw new LexUnclear('too much work');
  }

  private enter(): void {
    this.nest++;
    if (this.nest > MAX_NESTING) throw new LexUnclear('nesting too deep');
  }

  private leave(): void {
    this.nest--;
  }

  /**
   * Reads commands up to the end of the input, or up to the `)` that closes a substitution.
   * Every command is appended to the shared output.
   */
  private parseList(closeOnParen: boolean): void {
    const src = this.src;
    const st = new ListState(this.pending, this.shared.out);
    let parenDepth = 0;
    for (;;) {
      this.tick();
      if (this.pos >= src.length) break;
      const ch = src.charAt(this.pos);
      const next = src.charAt(this.pos + 1);

      if (ch === '\\') {
        if (next === '\n') {
          this.pos += 2;
        } else if (next === '\r' && src.charAt(this.pos + 2) === '\n') {
          this.pos += 3;
        } else {
          const word = st.word();
          word.quote();
          if (next === '') {
            word.literal('\\');
            this.pos++;
          } else {
            word.literal(next);
            this.pos += 2;
          }
        }
      } else if (ch === "'") {
        const word = st.word();
        word.quote();
        const start = this.pos + 1;
        this.skipSingleQuoted();
        word.literal(src.slice(start, this.pos - 1));
      } else if (ch === '"') {
        const word = st.word();
        this.pos++;
        this.scanDq(word);
      } else if (ch === '`') {
        const word = st.word();
        const start = this.pos;
        this.pos++;
        this.scanBacktick(false);
        word.expansion(src.slice(start, this.pos));
      } else if (ch === '$') {
        this.scanDollar(false, st.word());
      } else if ((ch === '<' || ch === '>') && next === '(') {
        const word = st.word();
        const start = this.pos;
        this.pos += 2;
        this.scanSubstitution();
        word.expansion(src.slice(start, this.pos));
      } else if (ch === '\n') {
        st.endCommand();
        this.pos++;
        this.readHeredocBodies();
      } else if (isBlank(ch)) {
        st.endWord();
        this.pos++;
      } else if (ch === '#' && !st.inWord()) {
        // A comment runs to the end of the line; what is in it is not code. Inside [[ ]] it is literal.
        if (st.inConditional()) throw new LexUnclear('# inside [[ ]]');
        const end = src.indexOf('\n', this.pos);
        this.pos = end === -1 ? src.length : end;
      } else if (ch === ';') {
        // End the pending word first: a trailing `esac` closes the case before this separator.
        st.endWord();
        // A lone `;` ends a command; while reading case patterns it is a malformed list.
        if (next !== ';' && next !== '&' && st.inPattern()) throw new LexUnclear('separator in case pattern');
        st.endCommand();
        if (next === ';') {
          this.pos += src.charAt(this.pos + 2) === '&' ? 3 : 2;
          st.clauseEnd();
        } else if (next === '&') {
          this.pos += 2;
          st.clauseEnd();
        } else {
          this.pos++;
        }
      } else if (ch === '|') {
        st.endWord();
        // Between case patterns (a|b)) a single | separates alternatives; || there is malformed.
        if (st.inPattern()) {
          if (next === '|') throw new LexUnclear('separator in case pattern');
          st.patternAlt();
        } else {
          st.endCommand();
        }
        this.pos++;
      } else if (ch === '&') {
        if (next === '>') {
          // &> and &>> send both streams to a file.
          st.endWord();
          st.markNotPrefix();
          this.pos += src.charAt(this.pos + 2) === '>' ? 3 : 2;
          st.redirect = 'file';
        } else {
          st.endWord();
          if (st.inPattern()) throw new LexUnclear('separator in case pattern');
          st.endCommand();
          this.pos++;
        }
      } else if (ch === '<' || ch === '>') {
        // Inside [[ ]] a `<` is a string comparison, not a redirection: the `(a <<E )` form (N6
        // sibling) would otherwise read a phantom heredoc. Fail closed rather than guess.
        if (ch === '<' && st.inConditional()) throw new LexUnclear('< inside [[ ]]');
        this.redirectOperator(st, ch, next);
      } else if (ch === '(') {
        if (st.pendingExtglob()) throw new LexUnclear('extglob pattern');
        st.endWord();
        if (st.inPattern()) {
          this.pos++; // the optional ( in front of a case pattern
          continue;
        }
        if (next === '(' && st.redirect === null && st.canStartArith()) {
          // ((...)) is arithmetic, where << is a shift and not a heredoc. If it does not close with ))
          // bash reads nested subshells instead, and handles a heredoc inside them in its own way.
          this.pos += 2;
          if (!this.scanArith('paren')) throw new LexUnclear('cannot tell whether (( is arithmetic');
          // `for ((...)) do cmd` has no separator before the command that follows.
          st.endCommand();
          continue;
        }
        let k = this.pos + 1;
        while (src.charAt(k) === ' ' || src.charAt(k) === '\t') k++;
        // "f() {" and "a=()" are definitions this guard does not model.
        if (src.charAt(k) === ')') throw new LexUnclear('empty parentheses');
        st.endCommand();
        parenDepth++;
        this.pos++;
      } else if (ch === ')') {
        st.endWord(); // may be `esac`, which closes the case
        if (st.inPattern()) {
          st.patternEnd();
          this.pos++;
          continue;
        }
        st.endCommand();
        this.pos++;
        if (parenDepth > 0) parenDepth--;
        else if (closeOnParen) return;
      } else {
        st.word().plain(ch);
        this.pos++;
      }
    }
    st.endCommand();
    if (closeOnParen) throw new LexUnclear('unterminated command substitution');
  }

  /** At `<` or `>` (not `<(` or `>(`): reads the operator and marks the next word as its target. */
  private redirectOperator(st: ListState, ch: string, next: string): void {
    st.markNotPrefix();
    // A bare fd number (2>&1) or a {name} variable-fd target belongs to the redirection, not the command.
    if (!st.takeFd() && !st.takeVarFd()) st.endWord();
    const third = this.src.charAt(this.pos + 2);
    let kind: Redirect = 'file';
    if (ch === '<') {
      if (next === '<' && third === '<') {
        // A here-string feeds this command's stdin as literal data, not as a script the guard
        // cannot see; it is tracked apart from a heredoc so it does not block xargs or a shell -c.
        this.pos += 3;
        st.herestring = true;
      } else if (next === '<') {
        const dash = third === '-';
        this.pos += dash ? 3 : 2;
        kind = dash ? 'heredoc-dash' : 'heredoc';
        st.heredoc = true;
      } else {
        this.pos += next === '&' || next === '>' ? 2 : 1;
      }
    } else {
      this.pos += next === '>' || next === '&' || next === '|' ? 2 : 1;
    }
    st.redirect = kind;
  }

  /** After the newline that ends a line: reads the bodies of the heredocs started on it. */
  private readHeredocBodies(): void {
    if (this.pending.length === 0) return;
    const src = this.src;
    for (const heredoc of this.pending.splice(0)) {
      const bodyStart = this.pos;
      let bodyEnd = src.length;
      while (this.pos < src.length) {
        this.tick();
        const newline = src.indexOf('\n', this.pos);
        const lineEnd = newline === -1 ? src.length : newline;
        const line = src.slice(this.pos, lineEnd);
        const compared = heredoc.strip ? line.replace(/^\t+/, '') : line;
        const lineStart = this.pos;
        this.pos = newline === -1 ? src.length : newline + 1;
        if (compared === heredoc.delimiter) {
          bodyEnd = lineStart;
          break;
        }
      }
      if (!heredoc.quoted) this.subLexer(src.slice(bodyStart, bodyEnd)).runHeredocBody();
    }
  }

  private subLexer(text: string): Lexer {
    if (this.nest + 1 > MAX_NESTING) throw new LexUnclear('nesting too deep');
    return new Lexer(text, this.nest + 1, this.shared);
  }

  /** At the opening `'`: moves past the closing one. */
  private skipSingleQuoted(): void {
    const end = this.src.indexOf("'", this.pos + 1);
    if (end === -1) throw new LexUnclear('unterminated single quote');
    this.pos = end + 1;
  }

  /** After `<(`, `>(` or `$(`: reads the commands inside, up to the closing `)`. */
  private scanSubstitution(): void {
    this.enter();
    // A substitution starts with no pending heredocs of its own, so an outer heredoc body only
    // begins after the outer newline, not after a newline inside the substitution.
    const saved = this.pending;
    this.pending = [];
    this.parseList(true);
    this.pending = saved;
    this.leave();
  }

  /** After the opening backtick. The body is un-escaped and lexed as commands of its own. */
  private scanBacktick(inDq: boolean): void {
    const src = this.src;
    let body = '';
    for (;;) {
      this.tick();
      if (this.pos >= src.length) throw new LexUnclear('unterminated backtick');
      const ch = src.charAt(this.pos);
      if (ch === '`') {
        this.pos++;
        break;
      }
      if (ch === '\\') {
        const next = src.charAt(this.pos + 1);
        if (next === '`' || next === '\\' || next === '$' || (inDq && next === '"')) {
          body += next;
          this.pos += 2;
          continue;
        }
        if (next === '\n') {
          this.pos += 2;
          continue;
        }
      }
      body += ch;
      this.pos++;
    }
    this.subLexer(body).run();
  }

  /** After the opening `"`: reads to the closing one. Substitutions inside are commands. */
  private scanDq(word: WordBuilder | null): void {
    const src = this.src;
    word?.quote();
    for (;;) {
      this.tick();
      if (this.pos >= src.length) throw new LexUnclear('unterminated double quote');
      const ch = src.charAt(this.pos);
      if (ch === '"') {
        this.pos++;
        return;
      }
      if (ch === '\\') {
        const next = src.charAt(this.pos + 1);
        if (next === '\n') {
          this.pos += 2;
        } else if (next !== '' && '$`"\\'.includes(next)) {
          word?.literal(next);
          this.pos += 2;
        } else {
          word?.literal('\\');
          this.pos++;
        }
      } else if (ch === '$') {
        this.scanDollar(true, word);
      } else if (ch === '`') {
        const start = this.pos;
        this.pos++;
        this.scanBacktick(true);
        word?.expansion(src.slice(start, this.pos));
      } else {
        word?.literal(ch);
        this.pos++;
      }
    }
  }

  /** At a `$`: reads the expansion it starts. */
  private scanDollar(inDq: boolean, word: WordBuilder | null): void {
    const src = this.src;
    const start = this.pos;
    const next = src.charAt(start + 1);
    if (next === '(') {
      if (src.charAt(start + 2) === '(') {
        this.pos = start + 3;
        // $(( is arithmetic. If it does not close with )) bash reads it as a subshell, which this guard will not guess.
        if (!this.scanArith('paren')) throw new LexUnclear('cannot tell whether $(( is arithmetic');
      } else {
        this.pos = start + 2;
        this.scanSubstitution();
      }
    } else if (next === '{') {
      this.pos = start + 2;
      this.scanParam(inDq);
    } else if (next === '[') {
      this.pos = start + 2;
      if (!this.scanArith('bracket')) throw new LexUnclear('unterminated $[');
    } else if (!inDq && next === "'") {
      this.pos = start + 2;
      this.skipAnsiC();
    } else if (!inDq && next === '"') {
      this.pos = start + 2;
      this.scanDq(null);
    } else {
      this.pos = start + 1;
    }
    word?.expansion(src.slice(start, this.pos));
  }

  /** After `$'`: an ANSI-C string, where a backslash can escape the closing quote. */
  private skipAnsiC(): void {
    const src = this.src;
    for (;;) {
      this.tick();
      if (this.pos >= src.length) throw new LexUnclear('unterminated $\'');
      const ch = src.charAt(this.pos);
      if (ch === '\\') {
        this.pos += 2;
      } else {
        this.pos++;
        if (ch === "'") return;
      }
    }
  }

  /** After `${`: skips to the closing `}`, reading the substitutions and quotes on the way. */
  private scanParam(inDq: boolean): void {
    this.enter();
    const src = this.src;
    for (;;) {
      this.tick();
      if (this.pos >= src.length) throw new LexUnclear('unterminated ${');
      const ch = src.charAt(this.pos);
      if (ch === '}') {
        this.pos++;
        break;
      }
      if (ch === '\\') {
        this.pos += 2;
      } else if (ch === "'") {
        // bash 5 reads a ' inside "${...}" as a quote and older bash does not. Do not guess.
        if (inDq) throw new LexUnclear("' inside a double-quoted ${...}");
        const start = this.pos + 1;
        this.skipSingleQuoted();
        // A subscript or offset in ${...} is evaluated as arithmetic, which strips the quotes and
        // runs any $(...) or backtick they hid. The lexer never saw it as a command, so fail closed.
        const quoted = src.slice(start, this.pos - 1);
        if (/\$\((?!\()/.test(quoted) || quoted.includes('`')) {
          throw new LexUnclear('quoted command substitution inside ${...}');
        }
      } else if (ch === '"') {
        this.pos++;
        this.scanDq(null);
      } else if (ch === '`') {
        this.pos++;
        this.scanBacktick(false);
      } else if (ch === '$') {
        this.scanDollar(inDq, null);
      } else {
        this.pos++;
      }
    }
    this.leave();
  }

  /**
   * After `$((`, `((` or `$[`: skips an arithmetic expression, where `<<` is a shift and `;` or `&`
   * are operators. Substitutions inside are still commands. Returns false when the expression does
   * not close the way arithmetic does: bash reads a subshell then, and this guard does not guess.
   */
  private scanArith(kind: 'paren' | 'bracket'): boolean {
    this.enter();
    const src = this.src;
    const innerStart = this.pos;
    // For (( the opening pair is already consumed, so depth 2 means "inside the expression".
    let depth = kind === 'paren' ? 2 : 1;
    for (;;) {
      this.tick();
      if (this.pos >= src.length) {
        this.leave();
        return false;
      }
      const ch = src.charAt(this.pos);
      if (ch === '\\') {
        this.pos += 2;
      } else if (ch === "'") {
        this.skipSingleQuoted();
      } else if (ch === '"') {
        this.pos++;
        this.scanDq(null);
      } else if (ch === '`') {
        this.pos++;
        this.scanBacktick(false);
      } else if (ch === '$') {
        this.scanDollar(false, null);
      } else if (kind === 'paren' && ch === '(') {
        depth++;
        this.pos++;
      } else if (kind === 'paren' && ch === ')') {
        depth--;
        if (depth === 1) {
          // The expression ends here, and only a second ) right after it makes this arithmetic.
          const closed = src.charAt(this.pos + 1) === ')';
          if (closed) {
            checkArithOperand(src.slice(innerStart, this.pos));
            this.pos += 2;
          }
          this.leave();
          return closed;
        }
        this.pos++;
      } else if (kind === 'bracket' && ch === '[') {
        depth++;
        this.pos++;
      } else if (kind === 'bracket' && ch === ']') {
        depth--;
        this.pos++;
        if (depth === 0) {
          checkArithOperand(src.slice(innerStart, this.pos - 1));
          this.leave();
          return true;
        }
      } else {
        this.pos++;
      }
    }
  }
}

/** Removes every balanced `${...}` span; their contents were already scanned as they were read. */
function stripParamExpansions(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; ) {
    if (s.charAt(i) === '$' && s.charAt(i + 1) === '{') {
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        const ch = s.charAt(i);
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
      }
    } else {
      out += s.charAt(i);
      i++;
    }
  }
  return out;
}

/**
 * A bare variable name as the whole arithmetic operand (`$((x))`, `(( x ))`) has bash re-evaluate
 * that variable's string as arithmetic, which recursively expands any `$(...)` a subscript holds, so
 * it fails closed. A `${...}` expansion and a subscript whose index is digits, a plain `$name`, or
 * `@`/`*` (`arr[0]`, `arr[$i]`, `${#a[@]}`) are read directly, so they are safe; any other subscript
 * fails closed. A literal-number expression (`1 + 2`, `i + 1`, `1 << 2`) is safe.
 */
function checkArithOperand(inner: string): void {
  const trimmed = inner.trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new LexUnclear('arithmetic operand is a bare name');
  }
  const remaining = stripParamExpansions(trimmed).replace(
    /[A-Za-z_][A-Za-z0-9_]*\[\s*(?:\d+|\$[A-Za-z_][A-Za-z0-9_]*|[@*])\s*\]/g,
    '',
  );
  if (remaining.includes('[')) {
    throw new LexUnclear('arithmetic subscript is not a simple index');
  }
}

/**
 * Splits a bash command line into simple commands. Throws LexUnclear when the input cannot be read
 * with confidence. `depth` is how deep this text already sits (a `-c` string inside a `-c` string).
 */
export function lexShell(input: string, depth = 0): LexCommand[] {
  const shared: Shared = { out: [], steps: 0, budget: 20_000 + input.length * 50 };
  new Lexer(input, depth, shared).run();
  return shared.out;
}

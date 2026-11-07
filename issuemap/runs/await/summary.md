# The Rust `await` syntax debate: a summary

## Background

The async/await RFC (2394) accepted `async fn` and `await` but left the final surface syntax of `await` open. Nightly used a placeholder macro, `await!(fut)`. The discussion started on the tracking issue (#50547) in May 2018 and moved to a dedicated issue (#57640) in January 2019, when it became very busy. In February 2019 the lang team locked it, saying it had "served its purpose of exploring the design space" and that they had no consensus yet. They promised a summary write-up. Comments in mid-2019 refer to a final decision made elsewhere (internals threads and a blog post); one commenter who dislikes it implies it is postfix.

The question comes up because of Rust's postfix `?` operator. Most futures resolve to a `Result`, so awaiting almost always comes paired with `?`, and with a prefix keyword the precedence is unclear. `await fut?` could mean `await (fut?)` or `(await fut)?`. C#, JS and Python don't have this problem because they use exceptions.

## Options proposed

**Prefix forms**
- **Useful precedence:** `await fut?` means `(await fut)?`. It's convenient but goes against the whitespace intuition.
- **Obvious precedence plus sugar:** `await fut?` means `await (fut?)`, and a combined `await? fut` gives `(await fut)?`.
- **Mandatory delimiters:** `await(fut)?` or `await { fut }?`.
- **Keep the macro:** stabilize `await!(fut)` and maybe add a postfix form later, the way `try!` came before `?`.

**Postfix forms**
- **Postfix keyword with a space:** `fut await?`.
- **Postfix field:** `fut.await?`. It's still a keyword, highlighted as one.
- **Postfix method:** `fut.await()?`.
- **Postfix macro:** `fut.await!()?`. This needs postfix macros as a general feature, or a special case.
- **Sigils:** `fut@?`, `fut#`, `fut~`, `fut!`, `...`, `->`, plus hybrids like `fut@await` or `fut#await`.

**Other ideas**
- Implicit await, or "explicit async, implicit await". The moderators ruled this out of scope.
- Await in patterns or bindings, e.g. `let await x = ...`.
- Await blocks that await everything inside them.
- "Deferred prefix" or extended-dot syntax, e.g. `client.[await send()]`.
- Pipeline operators.
- Having both a prefix and a postfix form.

## Main arguments

**For prefix (keyword or macro)**
- **Familiarity:** C#, JS, Python, C++ (`co_await`), Dart and Hack all use prefix. Rust has already "stretched its unfamiliarity budget" (withoutboats).
- **Visibility:** suspension points are important control flow and should sit at the front of a line, where readers scan. People with production coroutine experience said finding yield points at a glance is critical. They pointed to bugs like holding a `RefCell` across a suspension point, or game-state coroutines.
- **C# experience:** a C# designer reported that users rarely chain after `await`, still like how heavy the keyword is years later, and that C# never seriously considered postfix.
- **Chaining is overrated:** a chain of awaits is a code smell, and `let` bindings help with debugging, stack traces and type inference. One survey of popular Rust repos found very few lines or chains with more than one `?`. Others answered that the measurement doesn't capture multi-line expressions.
- **Postfix options look like other things:** `.await` looks like a field access, which suggests something cheap. `.await()` looks like a method you could call through UFCS. A bare `fut await` breaks up visual grouping and has no precedent anywhere. Sigils hurt grep-ability and search, can be invisible next to `?`, and push Rust toward "Perl line noise".
- **Macro case:** `await!()` already works and is unambiguous. "Magic" built-in macros like `format!` and `compile_error!` already exist. It also leaves room to add a postfix form later.

**For postfix**
- **Fits the `?` operator:** `fut.await?` reads left to right with no precedence puzzle. Prefix puts two related operators on opposite sides of an expression.
- **Rust code is built around method chains:** in real async code, such as a ~24k-line codebase and reqwest/hyper examples, rewriting to postfix removed temporary bindings and parentheses. The same reasoning made postfix `?` replace `try!`.
- **The visibility worry already proved false once:** the same "it hides control flow" objection was raised against `?` and didn't come true. People already scan line ends for `?`, so `.await?` gets noticed.
- **C# isn't a good comparison:** without `?`, C# code rarely needs `(await x).M()`. A survey of real C# code still turned up many awkward `(await x).Prop` patterns.
- **Benefits of `.await` in particular** (Centril's criteria): it keeps `await` a keyword, works with the dot in IDE autocomplete and muscle memory, has predictable field-like precedence, is greppable, and can be chained.
- **Rust's semantics differ anyway:** Rust futures are lazy, poll-based state machines, not running tasks. So a familiar keyword might wrongly suggest C#/JS behaviour. Opponents said users won't notice the difference.

**Against the macro as a stopgap**
- Stabilizing `await!` knowingly creates technical debt.
- It repeats the painful deprecation of `try!`. Unlike `try!`, it can't be written in user code.
- It either gives up `await` as a keyword or needs special-casing on top of special-casing.
- Macro syntax feels second-class for a central feature.
- Editions can't easily switch from prefix to postfix later.

## Cruxes

1. **How much will people chain after `await`, and should the syntax encourage it?** Postfix supporters expect awaits in method chains (especially with `?`) to be common and idiomatic in Rust. Prefix supporters think one await per statement, with `let` bindings, is better style and more common in practice. Both sides admit the existing evidence (C#, current Rust repos) is shaped by the syntax people had.
2. **Must suspension points be visually prominent, or is `?`-like subtlety acceptable?** If await points need to stand out at the start of a line, prefix wins. If the `?` precedent shows readers adapt to postfix markers, postfix is fine.
3. **Familiarity vs. internal consistency:** should Rust follow what other languages do, or follow its own conventions (postfix `?`, method chaining, laziness), given how different Rust's futures and error handling are?
4. **Is it acceptable for a construct to look like something it isn't?** For example, `.await` looking like a field, `.await()` like a method, or `.await!()` like a macro. This decides between the postfix variants. If none is acceptable, the remaining options are a space-separated keyword, a sigil, or prefix.
5. **Ship something provisional now, or decide the final syntax first?** One side wants to use `await!()` to gather real-world data. The other side calls that debt that won't be paid off.

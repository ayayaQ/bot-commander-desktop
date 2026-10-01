// Mirrors the production interpreter's expression exclusion rules for comments/strings.
// It intentionally does not import the privileged interpreter.
class ScriptExpressionScanner {
  isPositionInJsComment(code: string, position: number): boolean {
    let i = 0
    while (i < code.length && i <= position) {
      // Check for regular string literals - variables inside should NOT be evaluated
      if (code[i] === '"' || code[i] === "'") {
        const quote = code[i]
        const stringStart = i
        i++
        while (i < code.length) {
          if (code[i] === '\\' && i + 1 < code.length) {
            i += 2 // Skip escaped character
            continue
          }
          if (code[i] === quote) {
            i++
            break
          }
          i++
        }
        // Check if position is within this string
        if (position >= stringStart && position < i) {
          return true
        }
        continue
      }

      // Check for template literals - more complex handling needed
      if (code[i] === '`') {
        const result = this.checkTemplatePosition(code, i, position)
        if (result.found) {
          return result.shouldSkip
        }
        i = result.endIndex
        continue
      }

      // Check for line comment
      if (code[i] === '/' && i + 1 < code.length && code[i + 1] === '/') {
        const commentStart = i
        // Find end of line
        while (i < code.length && code[i] !== '\n') {
          i++
        }
        // Check if position is within this comment
        if (position >= commentStart && position < i) {
          return true
        }
        continue
      }

      // Check for block comment
      if (code[i] === '/' && i + 1 < code.length && code[i + 1] === '*') {
        const commentStart = i
        i += 2
        // Find end of block comment
        while (i < code.length) {
          if (code[i] === '*' && i + 1 < code.length && code[i + 1] === '/') {
            i += 2
            break
          }
          i++
        }
        // Check if position is within this comment
        if (position >= commentStart && position < i) {
          return true
        }
        continue
      }

      i++
    }

    return false
  }

  /**
   * Check if position is inside a template literal and whether it should be skipped.
   * Variables inside ${...} interpolations should be evaluated.
   * Variables in the static parts of the template should be skipped.
   */
  checkTemplatePosition(
    code: string,
    startIndex: number,
    position: number,
    depth = 0
  ): { found: boolean; shouldSkip: boolean; endIndex: number } {
    if (depth > 32) throw new Error('Script template nesting exceeds the playground limit')
    let i = startIndex + 1 // Skip opening backtick
    const templateStart = startIndex

    while (i < code.length) {
      if (code[i] === '\\' && i + 1 < code.length) {
        i += 2 // Skip escaped character
        continue
      }

      // Check for interpolation start
      if (code[i] === '$' && i + 1 < code.length && code[i + 1] === '{') {
        const interpStart = i
        i += 2 // Skip ${
        let braceDepth = 1

        // Find matching closing brace, handling nested braces and strings
        while (i < code.length && braceDepth > 0) {
          if (code[i] === '\\' && i + 1 < code.length) {
            i += 2
            continue
          }
          if (code[i] === '{') {
            braceDepth++
          } else if (code[i] === '}') {
            braceDepth--
          } else if (code[i] === '"' || code[i] === "'") {
            // Skip nested string inside interpolation
            const quote = code[i]
            i++
            while (i < code.length) {
              if (code[i] === '\\' && i + 1 < code.length) {
                i += 2
                continue
              }
              if (code[i] === quote) {
                break
              }
              i++
            }
          } else if (code[i] === '`') {
            // Handle nested template literal inside interpolation
            const nested = this.checkTemplatePosition(code, i, position, depth + 1)
            if (nested.found) {
              return nested
            }
            i = nested.endIndex
            continue
          }
          i++
        }

        const interpEnd = i
        // Check if position is inside the interpolation (between ${ and })
        // Position inside interpolation should NOT be skipped (should be evaluated)
        if (position >= interpStart + 2 && position < interpEnd - 1) {
          return { found: true, shouldSkip: false, endIndex: i }
        }
        continue
      }

      // End of template literal
      if (code[i] === '`') {
        const templateEnd = i + 1
        // Check if position is in the static part of the template (not in interpolation)
        if (position >= templateStart && position < templateEnd) {
          return { found: true, shouldSkip: true, endIndex: templateEnd }
        }
        return { found: false, shouldSkip: false, endIndex: templateEnd }
      }

      i++
    }

    // Unclosed template literal - treat remainder as template
    if (position >= templateStart) {
      return { found: true, shouldSkip: true, endIndex: i }
    }
    return { found: false, shouldSkip: false, endIndex: i }
  }
}

export function skipScriptExpression(code: string, position: number): boolean {
  return new ScriptExpressionScanner().isPositionInJsComment(code, position)
}

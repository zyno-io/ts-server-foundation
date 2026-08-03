package main

func isCodePosition(text string, pos int) bool {
	quote := byte(0)
	lineComment := false
	blockComment := false
	for i := 0; i < pos && i < len(text); i++ {
		current := text[i]
		next := byte(0)
		if i+1 < len(text) {
			next = text[i+1]
		}
		if lineComment {
			if current == '\n' || current == '\r' {
				lineComment = false
			}
			continue
		}
		if blockComment {
			if current == '*' && next == '/' {
				blockComment = false
				i++
			}
			continue
		}
		if quote != 0 {
			if current == '\\' {
				i++
				continue
			}
			if current == quote {
				quote = 0
			}
			continue
		}
		if current == '/' && next == '/' {
			lineComment = true
			i++
			continue
		}
		if current == '/' && next == '*' {
			blockComment = true
			i++
			continue
		}
		if current == '\'' || current == '"' || current == '`' {
			quote = current
		}
	}
	return quote == 0 && !lineComment && !blockComment
}

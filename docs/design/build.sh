#!/bin/sh
set -e
cd "$(dirname "$0")"
{ cat src/00-head.html; cat src/10-style.css; cat src/11-style.css; printf '</style>\n</head>\n<body>\n'; cat src/20-body.html; printf '<script>\n'; cat src/30-app.js; cat src/31-app.js; printf '\n</script>\n</body>\n</html>\n'; } > usage-redesign-concepts.html

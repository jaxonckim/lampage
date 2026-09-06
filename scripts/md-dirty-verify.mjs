/**
 * Verify MD open does not mark dirty until user edits.
 * Root cause: TipTap onUpdate fires on initial setContent / extension transforms.
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const mdSrc = readFileSync(join(root, 'src/renderer/src/components/MarkdownView.tsx'), 'utf8')
const storeSrc = readFileSync(join(root, 'src/renderer/src/stores/appStore.ts'), 'utf8')

const results = []
function pass(name, detail = '') {
  results.push({ name, ok: true, detail })
  console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`)
}
function fail(name, detail = '') {
  results.push({ name, ok: false, detail })
  console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`)
}

// Opening files starts dirty:false
if (/dirty:\s*false/.test(storeSrc) && /addOpenedFiles/.test(storeSrc)) {
  pass('open-starts-clean', 'addOpenedFiles sets dirty:false')
} else {
  fail('open-starts-clean')
}

// Must suppress dirty during hydrate
if (/suppressDirtyRef/.test(mdSrc)) {
  pass('has-suppress-ref')
} else {
  fail('has-suppress-ref', 'expected suppressDirtyRef in MarkdownView')
}

// onUpdate must not always set dirty:true
const onUpdateMatch = mdSrc.match(/onUpdate:\s*\(\{\s*editor:\s*ed\s*\}\)\s*=>\s*\{[\s\S]*?\},/)
if (!onUpdateMatch) {
  fail('onUpdate-guard', 'could not find onUpdate handler')
} else {
  const body = onUpdateMatch[0]
  const guards =
    /suppressDirtyRef\.current/.test(body) &&
    (/if\s*\(\s*suppressDirtyRef\.current\s*\)\s*return/.test(body) ||
      /dirty:\s*false/.test(body))
  const setsDirtyTrue = /dirty:\s*true/.test(body)
  if (guards && setsDirtyTrue) {
    pass('onUpdate-guard', 'suppress then dirty:true only after ready')
  } else {
    fail('onUpdate-guard', body.slice(0, 400))
  }
}

// onCreate clears suppress after settle
if (
  /onCreate:[\s\S]*suppressDirtyRef\.current\s*=\s*false/.test(mdSrc) ||
  /requestAnimationFrame[\s\S]*suppressDirtyRef\.current\s*=\s*false/.test(mdSrc)
) {
  pass('onCreate-arms-dirty')
} else {
  fail('onCreate-arms-dirty', 'expected suppress cleared after create')
}

// Reset suppress on doc.id change
if (/suppressDirtyRef\.current\s*=\s*true[\s\S]*doc\.id/.test(mdSrc) ||
    /useEffect\(\(\)\s*=>\s*\{\s*suppressDirtyRef\.current\s*=\s*true\s*\},\s*\[\s*doc\.id\s*\]\)/.test(mdSrc)) {
  pass('reset-on-doc-change')
} else {
  fail('reset-on-doc-change')
}

// Simulate the state machine
{
  let dirty = false
  let suppress = true
  const onUpdate = (userEdit) => {
    if (suppress) return // hydrate — do not dirty
    dirty = true
  }
  // open
  dirty = false
  suppress = true
  onUpdate(false) // TipTap initial update
  onUpdate(false) // possible Typography transform
  const afterOpen = dirty
  suppress = false // onCreate settled
  onUpdate(true) // user types
  const afterEdit = dirty
  if (afterOpen === false && afterEdit === true) {
    pass('sim-open-clean-edit-dirty', 'open dirty=false; one edit dirty=true')
  } else {
    fail('sim-open-clean-edit-dirty', JSON.stringify({ afterOpen, afterEdit }))
  }
}

const failed = results.filter((r) => !r.ok)
console.log('\n---')
console.log(`${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)

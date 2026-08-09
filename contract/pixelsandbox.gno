// Package pixelsandbox is a deliberately generic/throwaway practice
// deployment of the GNO Pixels design -- not the final intended realm
// name, so redeploying while the design is still changing (which it
// will be, more than once, on the way to something we're satisfied
// with) never collides with whatever the real, permanent realm ends
// up being called.
//
// Design itself matches this project's local pixelgame3 iteration:
// expandable bounds instead of a fixed size, per-pixel provenance (who
// placed it, at what block), and an owner-gated import hook for a
// possible future migration to a fresh, permanently-named deployment.
package pixelsandbox

import (
	"encoding/base64"
	"strconv"
	"strings"

	"chain"
	"chain/banker"
	runtime "chain/runtime"
	unsaferealm "chain/runtime/unsafe"

	"gno.land/p/nt/avl/v0"
	"gno.land/p/nt/ufmt/v0"
)

const (
	InitialMinX, InitialMaxX = int64(0), int64(63)
	InitialMinY, InitialMaxY = int64(0), int64(63)

	MaxBoardDim = 128
	ExpandStep  = 8

	ExpandThresholdPercent = 80

	CooldownBlocks = 1
	cellPx         = 8

	// FeePerPixelUgnot is charged for any placement that doesn't match
	// the current owner-curated official target (see officialTarget) --
	// placing toward the official design stays free, everything else
	// (free-form painting, or bulk-helping finish someone else's custom
	// canvas) costs this per cell, paid to collectionOwner.
	FeePerPixelUgnot = 100_000 // 0.1 GNOT

	// MaxBulkPixels bounds SetPixels' batch size -- keeps a single
	// transaction's gas/arg-size reasonable and bounds the worst-case
	// payment amount a caller has to attach.
	MaxBulkPixels = 10
)

var palette = []string{
	"#000000", "#ffffff", "#808080", "#ef4444",
	"#fb923c", "#facc15", "#4ade80", "#3b82f6", "#a855f7",
}

// collectionOwner is the address given for this project -- deploying
// account (whoever signs the addpkg transaction) and owner don't have
// to be the same address; this constant is what actually gates
// ForceExpand/ImportHistoricalPixel/CloseMigrationWindow regardless of
// who pays for the deploy itself.
const collectionOwner address = "g188mapat33awn7r9uk08l0jc9my0n07fpmspxel"

var (
	minX, maxX = InitialMinX, InitialMaxX
	minY, maxY = InitialMinY, InitialMaxY

	grid            avl.Tree
	placedBy        avl.Tree
	placedAtHeight  avl.Tree
	lastPlacedBlock avl.Tree
	placementCounts avl.Tree // address.String() -> int64, total successful placements (leaderboard)
	officialTarget  avl.Tree // key(x,y) -> int64 colorIndex, owner-curated free-to-place design

	totalPlacements int64
	occupiedCells   int64
	expansionsCount int64

	migrationOpen = true
)

func key(x, y int64) string {
	return strconv.FormatInt(x, 10) + "," + strconv.FormatInt(y, 10)
}

func callerAddress() address {
	return unsaferealm.PreviousRealm().Address()
}

func assertOwner() {
	if callerAddress() != collectionOwner {
		panic("owner-only")
	}
}

func getPixel(x, y int64) int64 {
	if c, ok := grid.Get(key(x, y)).(int64); ok {
		return c
	}
	return 0
}

func boardArea() int64  { return (maxX - minX + 1) * (maxY - minY + 1) }
func boardWidth() int64 { return maxX - minX + 1 }

func maybeExpand() {
	if boardWidth() >= MaxBoardDim {
		return
	}
	if occupiedCells*100 < boardArea()*ExpandThresholdPercent {
		return
	}
	expand()
}

func expand() {
	step := int64(ExpandStep)
	if boardWidth()+2*step > MaxBoardDim {
		step = (MaxBoardDim - boardWidth()) / 2
	}
	if step <= 0 {
		return
	}
	minX -= step
	maxX += step
	minY -= step
	maxY += step
	expansionsCount++
}

func ForceExpand(cur realm) {
	assertOwner()
	if boardWidth() >= MaxBoardDim {
		panic("already at max board size")
	}
	expand()
}

func inBounds(x, y int64) bool {
	return x >= minX && x <= maxX && y >= minY && y <= maxY
}

func recordPlacement(x, y, colorIndex int64, placer address, height int64) {
	k := key(x, y)
	wasDefault := grid.Get(k) == nil
	if colorIndex == 0 {
		grid.Remove(k)
		if !wasDefault {
			occupiedCells--
		}
	} else {
		grid.Set(k, colorIndex)
		if wasDefault {
			occupiedCells++
		}
	}
	placedBy.Set(k, placer.String())
	placedAtHeight.Set(k, height)
	bumpPlacementCount(placer)
}

// bumpPlacementCount counts every successful placement action (including
// recolors and erasures of an existing cell) toward the leaderboard --
// simpler and more transparent than trying to track "cells currently
// attributed to this address", which is a fuzzy concept on a canvas
// anyone can recolor.
func bumpPlacementCount(placer address) {
	k := placer.String()
	count, _ := placementCounts.Get(k).(int64)
	placementCounts.Set(k, count+1)
}

func isOfficialTarget(x, y, colorIndex int64) bool {
	c, ok := officialTarget.Get(key(x, y)).(int64)
	return ok && c == colorIndex
}

func IsOfficialTarget(x, y, colorIndex int64) bool { return isOfficialTarget(x, y, colorIndex) }

func FeePerPixel() int64        { return FeePerPixelUgnot }
func MaxBulkPixelsPerTx() int64 { return MaxBulkPixels }

// SetOfficialTarget bulk-registers (or replaces, if called again) the
// free-to-place design -- owner-only. encoded is "x,y,c;x,y,c;...",
// matching the CSV-ish convention already used by TopPlacers. Pass an
// empty string to clear the target entirely (every placement then
// requires payment).
func SetOfficialTarget(cur realm, encoded string) {
	assertOwner()
	officialTarget = avl.Tree{}
	if encoded == "" {
		return
	}
	for _, entry := range strings.Split(encoded, ";") {
		parts := strings.SplitN(entry, ",", 3)
		if len(parts) != 3 {
			panic("malformed entry: " + entry)
		}
		x, err1 := strconv.ParseInt(parts[0], 10, 64)
		y, err2 := strconv.ParseInt(parts[1], 10, 64)
		c, err3 := strconv.ParseInt(parts[2], 10, 64)
		if err1 != nil || err2 != nil || err3 != nil {
			panic("malformed entry: " + entry)
		}
		officialTarget.Set(key(x, y), c)
	}
}

// collectPayment verifies at least feeUgnot of ugnot was attached to
// this call (via the standard "send" field on /vm.m_call) and forwards
// exactly that much from the realm's own balance to collectionOwner,
// leaving any overpayment sitting in the realm's balance rather than
// dealing with refund complexity -- callers control how much they
// attach, so overpaying is their own choice, not something to protect
// against.
//
// chain/runtime/unsafe's own doc on OriginSend warns the envelope is
// shared across the whole call chain, so a malicious intermediate
// realm could consume it after a naive check passes (TOCTOU) -- the
// doc recommends pairing OriginSend with AssertOriginCall AND
// IsUserCall. AssertOriginCall specifically panics if invoked from
// anywhere but a top-level entry point (its own doc: "panic... when
// invoked by another method, even from the same realm or package"),
// so callers (SetPixel, SetPixels) call it themselves before reaching
// here rather than this helper calling it on their behalf.
func collectPayment(cur realm, feeUgnot int64) {
	if !unsaferealm.PreviousRealm().IsUserCall() {
		panic("payment must come from a direct user call")
	}
	sent := unsaferealm.OriginSend()
	var total int64
	for _, c := range sent {
		if c.Denom == "ugnot" {
			total += c.Amount
		}
	}
	if total < feeUgnot {
		panic(ufmt.Sprintf("insufficient payment: this placement costs %d ugnot, got %d", feeUgnot, total))
	}
	banker_ := banker.NewBanker(banker.BankerTypeRealmSend, cur)
	banker_.SendCoins(cur.Address(), collectionOwner, chain.Coins{chain.NewCoin("ugnot", feeUgnot)})
}

func SetPixel(cur realm, x, y, colorIndex int64) {
	runtime.AssertOriginCall()
	maybeExpand()
	if !inBounds(x, y) {
		panic("out of bounds")
	}
	if colorIndex < 0 || colorIndex >= int64(len(palette)) {
		panic("invalid color index")
	}
	caller := callerAddress()
	callerKey := caller.String()
	if last, ok := lastPlacedBlock.Get(callerKey).(int64); ok {
		elapsed := runtime.ChainHeight() - last
		if elapsed < CooldownBlocks {
			panic(ufmt.Sprintf("cooldown active: %d more block(s) to wait", CooldownBlocks-elapsed))
		}
	}
	if !isOfficialTarget(x, y, colorIndex) {
		collectPayment(cur, FeePerPixelUgnot)
	}
	recordPlacement(x, y, colorIndex, caller, runtime.ChainHeight())
	lastPlacedBlock.Set(callerKey, runtime.ChainHeight())
	totalPlacements++
}

// SetPixels places up to MaxBulkPixels pixels in one transaction.
// encoded is "x,y,c;x,y,c;...". Cooldown is checked and updated once
// for the whole batch rather than per pixel -- SetPixel's own per-call
// cooldown would otherwise reject every entry after the first within
// the same block, since they all execute in the same transaction/
// height. Fee is the sum of FeePerPixelUgnot across every entry that
// doesn't match the current official target, collected as one payment.
func SetPixels(cur realm, encoded string) {
	runtime.AssertOriginCall()
	entries := strings.Split(encoded, ";")
	if len(entries) == 0 || len(entries) > MaxBulkPixels {
		panic(ufmt.Sprintf("SetPixels accepts 1 to %d pixels per call", MaxBulkPixels))
	}
	maybeExpand()
	caller := callerAddress()
	callerKey := caller.String()
	if last, ok := lastPlacedBlock.Get(callerKey).(int64); ok {
		elapsed := runtime.ChainHeight() - last
		if elapsed < CooldownBlocks {
			panic(ufmt.Sprintf("cooldown active: %d more block(s) to wait", CooldownBlocks-elapsed))
		}
	}

	xs := make([]int64, len(entries))
	ys := make([]int64, len(entries))
	cs := make([]int64, len(entries))
	var feeTotal int64
	for i, entry := range entries {
		parts := strings.SplitN(entry, ",", 3)
		if len(parts) != 3 {
			panic("malformed entry: " + entry)
		}
		x, err1 := strconv.ParseInt(parts[0], 10, 64)
		y, err2 := strconv.ParseInt(parts[1], 10, 64)
		c, err3 := strconv.ParseInt(parts[2], 10, 64)
		if err1 != nil || err2 != nil || err3 != nil {
			panic("malformed entry: " + entry)
		}
		if !inBounds(x, y) {
			panic("out of bounds")
		}
		if c < 0 || c >= int64(len(palette)) {
			panic("invalid color index")
		}
		if !isOfficialTarget(x, y, c) {
			feeTotal += FeePerPixelUgnot
		}
		xs[i], ys[i], cs[i] = x, y, c
	}

	if feeTotal > 0 {
		collectPayment(cur, feeTotal)
	}

	height := runtime.ChainHeight()
	for i := range xs {
		recordPlacement(xs[i], ys[i], cs[i], caller, height)
		totalPlacements++
	}
	lastPlacedBlock.Set(callerKey, height)
}

func ImportHistoricalPixel(cur realm, x, y, colorIndex int64, originalPlacer address, originalHeight int64) {
	assertOwner()
	if !migrationOpen {
		panic("migration window is closed")
	}
	if colorIndex < 0 || colorIndex >= int64(len(palette)) {
		panic("invalid color index")
	}
	for x < minX || x > maxX || y < minY || y > maxY {
		if boardWidth() >= MaxBoardDim {
			panic("historical coordinate exceeds MaxBoardDim -- cannot import")
		}
		expand()
	}
	recordPlacement(x, y, colorIndex, originalPlacer, originalHeight)
	totalPlacements++
}

func CloseMigrationWindow(cur realm) {
	assertOwner()
	migrationOpen = false
}

func MigrationOpen() bool { return migrationOpen }

func GetPixel(x, y int64) int64 { return getPixel(x, y) }

func PlacedBy(x, y int64) (address, int64) {
	k := key(x, y)
	addr, _ := placedBy.Get(k).(string)
	height, _ := placedAtHeight.Get(k).(int64)
	return address(addr), height
}

func Bounds() (int64, int64, int64, int64) { return minX, maxX, minY, maxY }

func BoardWidth() int64  { return boardWidth() }
func BoardHeight() int64 { return maxY - minY + 1 }

func TotalPlacements() int64 { return totalPlacements }
func OccupiedCells() int64   { return occupiedCells }
func ExpansionsCount() int64 { return expansionsCount }

func PaletteCSV() string { return strings.Join(palette, ",") }

type placerCount struct {
	addr  string
	count int64
}

// TopPlacers returns up to n "address,count" pairs, semicolon-separated,
// sorted by count descending -- the leaderboard. Iterated fresh on every
// call rather than kept pre-sorted, since contributor counts are small
// enough (real participants, not per-pixel) for a plain insertion sort
// to be cheap regardless of how large the canvas itself grows. Gno's
// "sort" package predates Go's generics-based sort.Slice, so this is
// hand-rolled rather than using sort.Interface for a one-off local type.
func TopPlacers(n int64) string {
	var entries []placerCount
	placementCounts.Iterate("", "", func(k string, v any) bool {
		entries = append(entries, placerCount{k, v.(int64)})
		return false
	})
	for i := 1; i < len(entries); i++ {
		cur := entries[i]
		j := i - 1
		for j >= 0 && entries[j].count < cur.count {
			entries[j+1] = entries[j]
			j--
		}
		entries[j+1] = cur
	}
	if n >= 0 && int64(len(entries)) > n {
		entries = entries[:n]
	}
	var b strings.Builder
	for i, e := range entries {
		if i > 0 {
			b.WriteString(";")
		}
		b.WriteString(e.addr + "," + strconv.FormatInt(e.count, 10))
	}
	return b.String()
}

func CooldownRemaining(addr address) int64 {
	last, ok := lastPlacedBlock.Get(addr.String()).(int64)
	if !ok {
		return 0
	}
	elapsed := runtime.ChainHeight() - last
	if elapsed >= CooldownBlocks {
		return 0
	}
	return CooldownBlocks - elapsed
}

func Snapshot() string {
	var b strings.Builder
	for y := minY; y <= maxY; y++ {
		for x := minX; x <= maxX; x++ {
			b.WriteString(strconv.FormatInt(getPixel(x, y), 10))
		}
	}
	return b.String()
}

func canvasDataURI() string {
	w := (maxX - minX + 1) * cellPx
	h := (maxY - minY + 1) * cellPx
	var svg strings.Builder
	svg.WriteString(ufmt.Sprintf(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" shape-rendering="crispEdges">`,
		w, h,
	))
	svg.WriteString(ufmt.Sprintf(`<rect width="100%%" height="100%%" fill="%s"/>`, palette[0]))
	grid.Iterate("", "", func(k string, v any) bool {
		parts := strings.SplitN(k, ",", 2)
		x, _ := strconv.ParseInt(parts[0], 10, 64)
		y, _ := strconv.ParseInt(parts[1], 10, 64)
		c := v.(int64)
		svg.WriteString(ufmt.Sprintf(
			`<rect x="%d" y="%d" width="%d" height="%d" fill="%s"/>`,
			(x-minX)*cellPx, (y-minY)*cellPx, cellPx, cellPx, palette[c],
		))
		return false
	})
	svg.WriteString("</svg>")
	return "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(svg.String()))
}

func Render(path string) string {
	var b strings.Builder
	b.WriteString("# GNO Pixels (sandbox)\n\n")
	b.WriteString(ufmt.Sprintf(
		"A %dx%d collaborative on-chain canvas (grows toward a %dx%d max as it fills). `SetPixel(x, y, colorIndex)` takes no address -- the pixel always belongs to whoever signs, and there's a %d-block cooldown per address between placements.\n\n",
		boardWidth(), maxY-minY+1, MaxBoardDim, MaxBoardDim, CooldownBlocks,
	))
	b.WriteString(ufmt.Sprintf(
		"**Total placements:** %d | **Cells painted:** %d / %d | **Expansions so far:** %d\n\n",
		totalPlacements, occupiedCells, boardArea(), expansionsCount,
	))
	b.WriteString(ufmt.Sprintf("![canvas](%s)\n\n", canvasDataURI()))
	b.WriteString("## Palette\n\n")
	b.WriteString("| Index | Color |\n|---|---|\n")
	for i, hex := range palette {
		b.WriteString(ufmt.Sprintf("| %d | %s |\n", i, hex))
	}
	return b.String()
}

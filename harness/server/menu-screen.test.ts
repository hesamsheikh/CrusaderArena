import test from "node:test";
import assert from "node:assert/strict";
import { MENU_PROBES, menuScreen, type Rgb } from "./menu-screen.js";

/** Probe colours measured on captures from 2026-09-28, in MENU_PROBES' order. */
const screens: Record<string, Rgb[]> = {
  logo: Array(9).fill([0, 0, 0]),
  loading: [[143, 127, 101], [87, 76, 57], [52, 61, 63], [104, 106, 92], [170, 151, 115], [74, 57, 41], [190, 149, 99], [67, 67, 63], [52, 59, 57]],
  promo: [[62, 13, 10], [118, 77, 45], [203, 198, 191], [150, 148, 157], [111, 83, 32], [184, 163, 123], [98, 89, 63], [44, 25, 16], [97, 66, 47]],
  menu: [[12, 11, 7], [8, 7, 5], [5, 6, 7], [10, 10, 8], [16, 15, 11], [7, 6, 4], [182, 148, 101], [10, 5, 6], [52, 60, 57]],
  dialog: [[94, 22, 20], [92, 25, 21], [208, 174, 123], [209, 173, 123], [171, 144, 107], [170, 145, 110], [215, 177, 128], [206, 170, 120], [99, 18, 0]],
};

test("the probes name the main menu and the Load Game dialog, and nothing else", () => {
  assert.equal(Object.keys(MENU_PROBES).length, 9);
  assert.equal(menuScreen(screens.menu), "main_menu");
  assert.equal(menuScreen(screens.dialog), "load_dialog");
  for (const name of ["logo", "loading", "promo"]) assert.equal(menuScreen(screens[name]), "other", name);
});

test("a black screen is not the menu, and a short reading is nothing", () => {
  assert.equal(menuScreen(screens.logo), "other");
  assert.equal(menuScreen(screens.menu.slice(0, 5)), "other");
});

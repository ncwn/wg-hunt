import { createContext, useContext } from "react";

/**
 * True while the pages are kept behind the sign-in after a lost session. The Shell is inert then,
 * but what it portals into the body (a question, the photos) and what listens on the window is
 * not, so those read this and step aside until the seeker is signed in again.
 */
export const Suspended = createContext(false);

export const useSuspended = () => useContext(Suspended);

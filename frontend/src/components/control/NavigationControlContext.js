import { createContext, useContext } from 'react';

export const NavigationControlContext = createContext(null);

export function useNavigationManualState() {
  return useContext(NavigationControlContext).manualEnabled;
}

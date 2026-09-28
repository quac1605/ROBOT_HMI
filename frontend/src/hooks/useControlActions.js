import { createContext, useContext } from 'react';

export const ControlActionsContext = createContext(null);
export function useControlActions() {
    const value = useContext(ControlActionsContext);
    if (!value) throw new Error('Control actions require an authenticated provider.');
    return value;
}

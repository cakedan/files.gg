import { createContext, useContext } from 'react';

import type { StaffInfo } from '../../lib/api';

export const StaffContext = createContext<StaffInfo>({ role: 'moderator', child_safety: false });

/** The signed-in staff member's role and child-safety capability (§9.1). */
export const useStaff = () => useContext(StaffContext);

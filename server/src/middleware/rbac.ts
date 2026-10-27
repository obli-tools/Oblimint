import type { Request, Response, NextFunction } from 'express';
import type { UserRole } from '@oblimint/shared';
import { isMasterTenant } from '@oblimint/shared';
import { AppError } from './errorHandler';
import { permissionService } from '../services/permission.service';

export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.session?.userId) {
      next(new AppError(401, 'Authentication required'));
      return;
    }
    if (!roles.includes(req.session.role as UserRole)) {
      next(new AppError(403, 'Insufficient permissions'));
      return;
    }
    next();
  };
}

/** Platform administrator whose session sits on the master tenant (god view). */
export function requirePlatformAdminOnMaster(req: Request, _res: Response, next: NextFunction): void {
  if (!req.session?.userId) { next(new AppError(401, 'Authentication required')); return; }
  if (req.session.role !== 'admin') { next(new AppError(403, 'Admin only')); return; }
  if (!isMasterTenant(Number(req.session.currentTenantId))) {
    next(new AppError(403, 'Switch to the Default workspace to manage workspaces'));
    return;
  }
  next();
}

/**
 * Tenant-scoped capability check — a platform admin always passes; anyone
 * else needs the capability in the permission set of its membership of the
 * request's tenant (a tenant admin holds every capability). A client login
 * (users.kind = 'client') never passes: it holds no tenant capability
 * (permissionService, M12), its rights are per hosting account.
 */
export function requireTenantCapability(capability: string) {
  return requireAnyTenantCapability(capability);
}

export function requireAnyTenantCapability(...capabilities: string[]) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.session.role === 'admin') return next();
      const tenantId = (req as any).tenantId as number | undefined;
      if (!tenantId) return next(new AppError(403, 'Insufficient permissions'));
      for (const cap of capabilities) {
        if (await permissionService.userHasTenantCapability(req.session.userId!, tenantId, cap)) return next();
      }
      next(new AppError(403, 'Insufficient permissions'));
    } catch (err) {
      next(err);
    }
  };
}

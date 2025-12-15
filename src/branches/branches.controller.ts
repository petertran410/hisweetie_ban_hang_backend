@Get('my-branches')
@UseGuards(JwtAuthGuard)
async getMyBranches(@CurrentUser() user: any) {
  return this.branchesService.findByUser(user.id);
}